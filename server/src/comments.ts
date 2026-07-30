import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Actor, ActorKind, CanonError, Role, ROLE_RANK } from './model.js';
import type { Notifier } from './notify.js';

// Comments (CORE-PLAN.md Epic C, M2): inline comments anchored to a passage
// and page-level comments. An inline anchor stores the quoted passage plus
// optional surrounding context — simple and robust beats clever. The client
// relocates the quote in the current text and degrades to a page-level
// comment when the passage is gone; the record never depends on offsets into
// text that later edits would invalidate. Bodies are plain text; a body may
// mention actors with @<actorId>, and each mentioned actor is notified.
// Commenting requires the comment role on the collection, and every comment
// is attributed to its actor — person or agent — and lands in the audit log.

export const COMMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS comments (
  id             TEXT PRIMARY KEY,
  page_id        TEXT NOT NULL REFERENCES pages(id),
  author_id      TEXT NOT NULL REFERENCES actors(id),
  body           TEXT NOT NULL,
  anchor_quote   TEXT,
  anchor_context TEXT,
  resolved_at    TEXT,
  resolved_by    TEXT REFERENCES actors(id),
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(page_id);
`;

// A page-level comment carries no anchor. An inline comment anchors to the
// exact quoted passage, with optional context to disambiguate repeats.
export interface CommentAnchor {
  quote: string;
  context: string | null;
}

export interface Comment {
  id: string;
  pageId: string;
  authorId: string;
  authorKind: ActorKind; // attribution: agent comments are visibly agent work
  body: string;
  anchor: CommentAnchor | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

// Mention parsing is simple and exact: @ followed by an actor id, no fuzzy
// name matching. Candidates that name no existing actor are plain text.
const MENTION = /@([A-Za-z0-9][A-Za-z0-9-]*)/g;

export function parseMentions(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(MENTION)) ids.add(match[1]!);
  return [...ids];
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface CommentHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

function now(): string {
  return new Date().toISOString();
}

export class CommentService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: CommentHost,
    private readonly notifier: Notifier,
  ) {}

  create(actorId: string, pageId: string, input: { body: string; anchor?: Partial<CommentAnchor> | null }): Comment {
    const page = this.page(pageId);
    this.requireRole(actorId, page.collectionId, 'comment');
    if (page.status === 'archived') throw new CanonError('workflow', 'Archived pages are read-only');
    const body = input.body?.trim();
    if (!body) throw new CanonError('invalid', 'A comment requires a body');
    let anchor: CommentAnchor | null = null;
    if (input.anchor) {
      if (!input.anchor.quote?.trim()) {
        throw new CanonError('invalid', 'An inline comment anchors to a quoted passage');
      }
      anchor = { quote: input.anchor.quote, context: input.anchor.context ?? null };
    }

    const author = this.host.getActor(actorId);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO comments (id, page_id, author_id, body, anchor_quote, anchor_context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, pageId, actorId, body, anchor?.quote ?? null, anchor?.context ?? null, now());

    // Mentions: only candidates naming an existing actor count, and the
    // author is never notified about their own comment.
    const mentioned: Actor[] = [];
    for (const candidate of parseMentions(body)) {
      if (candidate === actorId) continue;
      try {
        mentioned.push(this.host.getActor(candidate));
      } catch {
        // not an actor id; plain text
      }
    }

    this.audit(author, 'comment.create', {
      collectionId: page.collectionId,
      pageId,
      details: { commentId: id, anchored: anchor !== null, mentions: mentioned.map((a) => a.id) },
    });

    for (const recipient of mentioned) {
      this.notifier.send(recipient.id, {
        kind: 'mention',
        subject: `${author.name} mentioned you on "${page.title}"`,
        body,
        link: `/pages/${pageId}#comment-${id}`,
      });
    }
    return this.getComment(id);
  }

  list(actorId: string, pageId: string): Comment[] {
    const page = this.page(pageId);
    this.requireRole(actorId, page.collectionId, 'view');
    const rows = this.db
      .prepare(
        `SELECT c.*, a.kind AS author_kind FROM comments c
         JOIN actors a ON a.id = c.author_id
         WHERE c.page_id = ? ORDER BY c.created_at, c.rowid`,
      )
      .all(pageId) as Record<string, unknown>[];
    return rows.map((r) => this.toComment(r));
  }

  resolve(actorId: string, commentId: string): Comment {
    const { comment, page } = this.commentWithPage(commentId);
    this.requireRole(actorId, page.collectionId, 'comment');
    if (comment.resolvedAt) throw new CanonError('workflow', 'This comment is already resolved');
    const actor = this.host.getActor(actorId);
    this.db
      .prepare('UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?')
      .run(now(), actorId, commentId);
    this.audit(actor, 'comment.resolve', {
      collectionId: page.collectionId,
      pageId: comment.pageId,
      details: { commentId },
    });
    return this.getComment(commentId);
  }

  reopen(actorId: string, commentId: string): Comment {
    const { comment, page } = this.commentWithPage(commentId);
    this.requireRole(actorId, page.collectionId, 'comment');
    if (!comment.resolvedAt) throw new CanonError('workflow', 'This comment is not resolved');
    const actor = this.host.getActor(actorId);
    this.db.prepare('UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?').run(commentId);
    this.audit(actor, 'comment.reopen', {
      collectionId: page.collectionId,
      pageId: comment.pageId,
      details: { commentId },
    });
    return this.getComment(commentId);
  }

  // ---- internals -------------------------------------------------------

  private getComment(id: string): Comment {
    const row = this.db
      .prepare(
        `SELECT c.*, a.kind AS author_kind FROM comments c
         JOIN actors a ON a.id = c.author_id WHERE c.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such comment: ${id}`);
    return this.toComment(row);
  }

  private commentWithPage(id: string): { comment: Comment; page: { collectionId: string } } {
    const comment = this.getComment(id);
    const page = this.page(comment.pageId);
    return { comment, page };
  }

  private toComment(row: Record<string, unknown>): Comment {
    const quote = (row.anchor_quote as string) ?? null;
    return {
      id: row.id as string,
      pageId: row.page_id as string,
      authorId: row.author_id as string,
      authorKind: row.author_kind as ActorKind,
      body: row.body as string,
      anchor: quote === null ? null : { quote, context: (row.anchor_context as string) ?? null },
      resolvedAt: (row.resolved_at as string) ?? null,
      resolvedBy: (row.resolved_by as string) ?? null,
      createdAt: row.created_at as string,
    };
  }

  private page(id: string): { id: string; collectionId: string; status: string; title: string } {
    const row = this.db.prepare('SELECT id, collection_id, status, title FROM pages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      status: row.status as string,
      title: row.title as string,
    };
  }

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      throw new CanonError('forbidden', `Requires ${needed} access to this collection`, {
        collectionId,
        needed,
        held: role,
      });
    }
  }

  private audit(
    actor: Actor,
    action: string,
    ctx: { collectionId?: string; pageId?: string; details?: Record<string, unknown> } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        actor.id,
        actor.kind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }
}
