import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError } from './model.js';
import { requireOrgRole } from './orgrole.js';

// Notifications (CORE-PLAN.md Epic C, M2) follow an outbox pattern, not live
// SMTP: every notification is first recorded in the notifications table with
// a null sent_at, then handed to a pluggable transport. If delivery fails the
// row stays queued for a later delivery pass; nothing is lost and nothing
// blocks the write that triggered it. Core ships a dev transport that logs to
// the console and marks sent, and an SMTP transport (email.ts) that sends the
// real thing; with no relay configured, the dev transport stays the default.
//
// The delivery pass is flushPending(): it retries queued rows with bounded
// attempts and backoff, records the attempt count and the last error on the
// row, and marks a permanently refused notification dead instead of retrying
// it forever. A row is never delivered twice — the marking update is
// conditional on the row still being unsent. See email.ts for the SMTP
// transport, which delivers only through this path.

export const NOTIFICATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  recipient_id    TEXT NOT NULL REFERENCES actors(id),
  kind            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  link            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  sent_at         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at TEXT,
  dead_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(sent_at, created_at);
`;

// Delivery columns arrived after the first outbox shipped, so a database
// created by an earlier build is brought up to date here rather than in a
// migration framework Core does not have. ADD COLUMN has no IF NOT EXISTS in
// SQLite, hence the guard.
const DELIVERY_COLUMNS: [string, string][] = [
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_error', 'TEXT'],
  ['next_attempt_at', 'TEXT'],
  ['dead_at', 'TEXT'],
];

function ensureDeliveryColumns(db: DatabaseSync): void {
  const present = new Set(
    (db.prepare('PRAGMA table_info(notifications)').all() as { name: string }[]).map((c) => c.name),
  );
  for (const [name, type] of DELIVERY_COLUMNS) {
    if (!present.has(name)) db.exec(`ALTER TABLE notifications ADD COLUMN ${name} ${type}`);
  }
}

// `review_due` is the freshness sweep's voice (freshness.ts): the owner of a
// Canonical page whose review date has passed is told, once, that the page is
// now Needs Update. It rides the same outbox as every other notification.
export type NotificationKind =
  | 'mention'
  | 'review_requested'
  | 'draft_approved'
  | 'draft_sent_back'
  // Agent proposals (proposals.ts, Next tier). The triggers live there, next
  // to the logic, exactly as the mention trigger lives in comments.ts.
  | 'proposal_opened'
  | 'proposal_accepted'
  | 'proposal_rejected'
  | 'proposal_superseded'
  | 'review_due';

export interface Notification {
  id: string;
  recipientId: string;
  kind: NotificationKind;
  subject: string;
  body: string;
  link: string;
  createdAt: string;
  sentAt: string | null;
  attempts: number; // delivery attempts made so far
  lastError: string | null; // why the last attempt failed, for the operator
  deadAt: string | null; // permanently refused, or out of attempts; never retried
}

// The transport is the only pluggable piece: it delivers one notification to
// one recipient, and throws to leave the notification queued in the outbox.
export interface NotificationTransport {
  deliver(notification: Notification, recipient: Actor): void;
}

// A transport that cannot finish inside the synchronous write path — anything
// doing real network I/O, such as the SMTP transport in email.ts — implements
// this as well. Its rows are left queued by send() and delivered by
// flushPending(), so the write that triggered the notification never waits on
// a mail relay. NotificationTransport itself is unchanged: an async transport
// is still a NotificationTransport, and every existing transport still works.
export interface AsyncNotificationTransport extends NotificationTransport {
  deliverAsync(notification: Notification, recipient: Actor): Promise<void>;
}

function isAsync(transport: NotificationTransport): transport is AsyncNotificationTransport {
  return typeof (transport as Partial<AsyncNotificationTransport>).deliverAsync === 'function';
}

// A transport reports a permanent failure — a refused address, a 5xx — by
// throwing an error carrying `permanent: true`. Anything else is transient and
// gets retried. This keeps the outbox from having to know what SMTP is.
function isPermanent(err: unknown): boolean {
  return (err as { permanent?: unknown } | null)?.permanent === true;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Bounded retries: five attempts spread over roughly an hour and a half,
// then the row is marked dead and an operator can see why in last_error.
export const MAX_DELIVERY_ATTEMPTS = 5;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface FlushResult {
  attempted: number;
  delivered: number;
  failed: number; // attempts that failed and stay queued for a later pass
  dead: number; // permanently refused, or out of attempts
  pending: number; // still queued after this pass
}

export interface FlushOptions {
  ignoreBackoff?: boolean; // deliver everything queued, regardless of its wait
}

// Every Notifier registers itself against the host it was built with (the
// CanonStore), so an HTTP route can reach the outbox without the store growing
// a new surface for it. See flushNotifications() below.
const notifiers = new WeakMap<object, Notifier>();

export function notifierFor(host: object): Notifier | undefined {
  return notifiers.get(host);
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

function toNotification(r: Record<string, unknown>): Notification {
  return {
    id: r.id as string,
    recipientId: r.recipient_id as string,
    kind: r.kind as NotificationKind,
    subject: r.subject as string,
    body: r.body as string,
    link: r.link as string,
    createdAt: r.created_at as string,
    sentAt: (r.sent_at as string) ?? null,
    attempts: Number(r.attempts ?? 0),
    lastError: (r.last_error as string) ?? null,
    deadAt: (r.dead_at as string) ?? null,
  };
}

export class Notifier {
  // Rows being delivered right now, so two overlapping flushes cannot hand
  // the same notification to the transport twice.
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly directory: ActorDirectory,
    private readonly transport: NotificationTransport = devTransport,
  ) {
    ensureDeliveryColumns(db);
    notifiers.set(directory, this);
  }

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
      attempts: 0,
      lastError: null,
      deadAt: null,
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
    // An async transport (real email) cannot complete inline, so its rows are
    // left queued for flushPending(). Synchronous transports are unaffected:
    // for them this is exactly the behaviour the outbox has always had.
    if (!isAsync(this.transport)) {
      try {
        this.transport.deliver(notification, recipient);
        const sentAt = now();
        this.db.prepare('UPDATE notifications SET sent_at = ? WHERE id = ?').run(sentAt, notification.id);
        notification.sentAt = sentAt;
      } catch {
        // Delivery failed; the notification stays queued (sent_at null) for a
        // later delivery pass. The triggering write already succeeded.
      }
    }
    return notification;
  }

  // An actor lists their own notifications, newest first.
  listFor(actorId: string): Notification[] {
    this.directory.getActor(actorId);
    const rows = this.db
      .prepare('SELECT * FROM notifications WHERE recipient_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(actorId) as Record<string, unknown>[];
    return rows.map((r) => toNotification(r));
  }

  // ---- delivery (retry, backoff, and the dead letter) -------------------

  // Re-attempt queued notifications: the rows send() could not deliver, and
  // every row an async transport left for this pass. Bounded by `limit` so a
  // flush on a timer stays a short, predictable piece of work.
  async flushPending(limit = 25, options: FlushOptions = {}): Promise<FlushResult> {
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications
          WHERE sent_at IS NULL AND dead_at IS NULL AND attempts < ?
            AND (? = 1 OR next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at, rowid
          LIMIT ?`,
      )
      .all(MAX_DELIVERY_ATTEMPTS, options.ignoreBackoff ? 1 : 0, now(), Math.max(1, limit)) as Record<
      string,
      unknown
    >[];

    const result: FlushResult = { attempted: 0, delivered: 0, failed: 0, dead: 0, pending: 0 };
    for (const row of rows) {
      const notification = toNotification(row);
      if (this.inFlight.has(notification.id)) continue;
      this.inFlight.add(notification.id);
      // The selection above was taken before any await, so re-read the row's
      // state: an overlapping flush may have delivered or killed it since.
      const current = this.db.prepare('SELECT sent_at, dead_at FROM notifications WHERE id = ?').get(notification.id) as
        | { sent_at: string | null; dead_at: string | null }
        | undefined;
      if (!current || current.sent_at || current.dead_at) {
        this.inFlight.delete(notification.id);
        continue;
      }
      result.attempted += 1;
      try {
        const recipient = this.directory.getActor(notification.recipientId);
        if (isAsync(this.transport)) {
          await this.transport.deliverAsync(notification, recipient);
        } else {
          this.transport.deliver(notification, recipient);
        }
        // Conditional on the row still being unsent: whatever else happens,
        // a notification is delivered at most once from the outbox.
        const marked = this.db
          .prepare('UPDATE notifications SET sent_at = ?, last_error = NULL WHERE id = ? AND sent_at IS NULL')
          .run(now(), notification.id);
        if (Number(marked.changes) === 1) result.delivered += 1;
      } catch (err) {
        const attempts = notification.attempts + 1;
        const permanent = isPermanent(err);
        const dead = permanent || attempts >= MAX_DELIVERY_ATTEMPTS;
        const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? 0;
        this.db
          .prepare(
            `UPDATE notifications
                SET attempts = ?, last_error = ?, next_attempt_at = ?, dead_at = ?
              WHERE id = ? AND sent_at IS NULL`,
          )
          .run(
            attempts,
            `${permanent ? 'permanent' : 'transient'}: ${messageOf(err)}`,
            new Date(Date.now() + wait).toISOString(),
            dead ? now() : null,
            notification.id,
          );
        if (dead) result.dead += 1;
        else result.failed += 1;
      } finally {
        this.inFlight.delete(notification.id);
      }
    }
    result.pending = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL AND dead_at IS NULL')
          .get() as { n: number }
      ).n,
    );
    return result;
  }

  // Queued but not yet delivered, oldest first: what a flush would work on.
  pending(limit = 100): Notification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications WHERE sent_at IS NULL AND dead_at IS NULL
          ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map((r) => toNotification(r));
  }

  // The permission-checked entry point behind POST /notifications/flush.
  // Flushing is an operator's job, and it now asks that question directly
  // (orgrole.ts) rather than through the "admin on some collection" stand-in
  // SECURITY.md R5 named. Delivering the outbox is running the system: it hands
  // every queued notification, from every collection, to a mail relay. A team
  // lead who administers one collection is not the person who does that, and an
  // operator who belongs to no collection is.
  async flushFor(actorId: string, limit?: number): Promise<FlushResult> {
    this.directory.getActor(actorId);
    requireOrgRole(this.db, actorId, 'operator', 'Flushing the notification outbox');
    return this.flushPending(limit);
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

// Behind POST /notifications/flush. A real deployment calls it on a timer
// (every minute or so) so a relay that was down for an hour costs nobody a
// notification; the HTTP route exists so an operator can also flush by hand.
export async function flushNotifications(host: object, actorId: string, limit?: number): Promise<FlushResult> {
  const notifier = notifierFor(host);
  if (!notifier) throw new CanonError('not_found', 'No notification outbox is attached to this record');
  return notifier.flushFor(actorId, limit);
}
