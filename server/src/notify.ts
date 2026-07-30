import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError } from './model.js';

// Notifications (CORE-PLAN.md Epic C, M2) follow an outbox pattern, not live
// SMTP: every notification is first recorded in the notifications table with
// a null sent_at, then handed to a pluggable transport. If delivery fails the
// row stays queued for a later delivery pass; nothing is lost and nothing
// blocks the write that triggered it. Core ships a dev transport that logs to
// the console and marks sent; real email lands with the email integration.

export const NOTIFICATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES actors(id),
  kind         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  link         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  sent_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
`;

export type NotificationKind = 'mention' | 'review_requested' | 'draft_approved' | 'draft_sent_back';

export interface Notification {
  id: string;
  recipientId: string;
  kind: NotificationKind;
  subject: string;
  body: string;
  link: string;
  createdAt: string;
  sentAt: string | null;
}

// The transport is the only pluggable piece: it delivers one notification to
// one recipient, and throws to leave the notification queued in the outbox.
export interface NotificationTransport {
  deliver(notification: Notification, recipient: Actor): void;
}

// Dev transport: logs to the console and lets the notification be marked sent.
export const devTransport: NotificationTransport = {
  deliver(notification, recipient) {
    console.log(
      `[notify] to=${recipient.name} <${recipient.email ?? 'no email'}> ` +
        `kind=${notification.kind} subject=${JSON.stringify(notification.subject)} link=${notification.link}`,
    );
  },
};

// The minimal slice of CanonStore the notifier needs; CanonStore satisfies it.
export interface ActorDirectory {
  getActor(id: string): Actor;
}

function now(): string {
  return new Date().toISOString();
}

export class Notifier {
  constructor(
    private readonly db: DatabaseSync,
    private readonly directory: ActorDirectory,
    private readonly transport: NotificationTransport = devTransport,
  ) {}

  // Outbox write plus a delivery attempt. The row exists before delivery is
  // tried, so a failing transport can never lose a notification.
  send(recipientId: string, input: { kind: NotificationKind; subject: string; body: string; link: string }): Notification {
    const recipient = this.directory.getActor(recipientId);
    const notification: Notification = {
      id: randomUUID(),
      recipientId,
      kind: input.kind,
      subject: input.subject,
      body: input.body,
      link: input.link,
      createdAt: now(),
      sentAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO notifications (id, recipient_id, kind, subject, body, link, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        notification.id,
        notification.recipientId,
        notification.kind,
        notification.subject,
        notification.body,
        notification.link,
        notification.createdAt,
      );
    try {
      this.transport.deliver(notification, recipient);
      const sentAt = now();
      this.db.prepare('UPDATE notifications SET sent_at = ? WHERE id = ?').run(sentAt, notification.id);
      notification.sentAt = sentAt;
    } catch {
      // Delivery failed; the notification stays queued (sent_at null) for a
      // later delivery pass. The triggering write already succeeded.
    }
    return notification;
  }

  // An actor lists their own notifications, newest first.
  listFor(actorId: string): Notification[] {
    this.directory.getActor(actorId);
    const rows = this.db
      .prepare('SELECT * FROM notifications WHERE recipient_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(actorId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      recipientId: r.recipient_id as string,
      kind: r.kind as NotificationKind,
      subject: r.subject as string,
      body: r.body as string,
      link: r.link as string,
      createdAt: r.created_at as string,
      sentAt: (r.sent_at as string) ?? null,
    }));
  }

  // ---- review triggers -------------------------------------------------
  // Called from the review workflow in store.ts. Each reads what it needs
  // from the record so the call sites stay one line each.

  // Page submitted: notify the named approver from the draft under review,
  // or, when the type names none (a Plan), every approve-role member.
  reviewRequested(byId: string, pageId: string): void {
    const page = this.page(pageId);
    const by = this.directory.getActor(byId);
    const draft = this.db.prepare('SELECT fields_json FROM drafts WHERE page_id = ?').get(pageId) as
      | { fields_json: string }
      | undefined;
    const fields = draft ? (JSON.parse(draft.fields_json) as { approverId?: string | null }) : {};
    const recipients = fields.approverId
      ? [fields.approverId]
      : (
          this.db
            .prepare(
              "SELECT actor_id FROM collection_members WHERE collection_id = ? AND role IN ('approve', 'admin')",
            )
            .all(page.collectionId) as { actor_id: string }[]
        ).map((r) => r.actor_id);
    this.fanOut(byId, recipients, {
      kind: 'review_requested',
      subject: `Review requested: ${page.title}`,
      body: `${by.name} submitted "${page.title}" for review.`,
      link: `/pages/${pageId}`,
    });
  }

  // Draft approved: notify the draft editor and the page owner.
  draftApproved(byId: string, pageId: string, editorId: string): void {
    const page = this.page(pageId);
    const by = this.directory.getActor(byId);
    this.fanOut(byId, [editorId, page.ownerId], {
      kind: 'draft_approved',
      subject: `Approved as Canonical: ${page.title}`,
      body: `${by.name} approved "${page.title}" as Canonical.`,
      link: `/pages/${pageId}`,
    });
  }

  // Draft sent back: notify the draft editor and the page owner, carrying
  // the approver's comment. Before a first publish the page row names no
  // owner yet, so the owner comes from the draft under review.
  draftSentBack(byId: string, pageId: string, comment: string): void {
    const page = this.page(pageId);
    const by = this.directory.getActor(byId);
    const draft = this.db.prepare('SELECT editor_id, fields_json FROM drafts WHERE page_id = ?').get(pageId) as
      | { editor_id: string; fields_json: string }
      | undefined;
    const fields = draft ? (JSON.parse(draft.fields_json) as { ownerId?: string | null }) : {};
    this.fanOut(byId, [draft?.editor_id ?? null, fields.ownerId ?? page.ownerId], {
      kind: 'draft_sent_back',
      subject: `Sent back: ${page.title}`,
      body: `${by.name} sent "${page.title}" back: ${comment}`,
      link: `/pages/${pageId}`,
    });
  }

  // Deduplicates recipients and never notifies the acting actor about
  // their own action.
  private fanOut(
    byId: string,
    candidates: (string | null | undefined)[],
    message: { kind: NotificationKind; subject: string; body: string; link: string },
  ): void {
    for (const recipientId of new Set(candidates.filter((id): id is string => Boolean(id)))) {
      if (recipientId === byId) continue;
      this.send(recipientId, message);
    }
  }

  private page(id: string): { id: string; collectionId: string; title: string; ownerId: string | null } {
    const row = this.db.prepare('SELECT id, collection_id, title, owner_id FROM pages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      title: row.title as string,
      ownerId: (row.owner_id as string) ?? null,
    };
  }
}
