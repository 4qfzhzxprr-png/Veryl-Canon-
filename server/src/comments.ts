import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { forbiddenRole, notFoundIfStranger } from './abilities.js';
import { Actor, ActorKind, actorNameForMessage, CanonError, Role, ROLE_RANK } from './model.js';
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
  /**
   * True when this comment IS an approver's send-back reason — the comment
   * `CanonStore.sendBack` files (USER-TESTING.md T4.3), so a panel can say
   * "sent this back" rather than showing the most consequential sentence on the
   * page as an ordinary remark.
   *
   * Derived, not stored: it is read from the `page.send_back` audit event that
   * names this comment. The log is already the record of who did what, and a
   * column here would be a second copy of that answer, free to disagree with
   * it. The mark therefore survives resubmission, which is right — the comment
   * goes on being the refusal it was even after the page has moved on.
   */
  sentBack: boolean;
}

// Mention parsing is simple and exact: @ followed by an actor id, no fuzzy
// name matching. Candidates that name no existing actor are plain text.
const MENTION = /@([A-Za-z0-9][A-Za-z0-9-]*)/g;

export function parseMentions(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(MENTION)) ids.add(match[1]!);
  return [...ids];
}

/**
 * Mentioning a person by NAME, which is the only way anybody was ever going to
 * do it.
 *
 * `@<actorId>` was the whole feature, and an actor id is a UUID. Nothing in the
 * composer said so, nothing offered one, and no reader of a page has a
 * colleague's UUID to hand — so "mention someone to bring them in", which the
 * product describes as a workflow, could not be performed by a person. The
 * mention machinery underneath it is careful and complete; it simply had no
 * usable address.
 *
 * Matched longest-name-first so "Dana Reyes" wins over a colleague called
 * "Dana", and case-insensitively because nobody capitalises consistently in a
 * comment box. A name that matches nothing stays plain text, exactly as an
 * unknown id does — an `@` in prose ("email @ the vendor") must not become a
 * failed mention that anybody has to explain.
 *
 * Pure, and takes the candidate list, so it can be unit-tested without a
 * database and so the CALLER decides who is nameable. That is a permission
 * decision, and it does not belong in a parser.
 */
export function resolveMentionNames(
  body: string,
  candidates: readonly { id: string; name: string }[],
): string[] {
  const text = String(body ?? '');
  const byLength = [...candidates]
    .filter((c) => (c.name ?? '').trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();
  const lower = text.toLowerCase();
  // Spans already spoken for by a longer name. Ordering alone is not enough:
  // "@Dana Reyes" contains "@Dana", so without claiming the span BOTH people
  // are notified and the shorter name is always a false positive of the longer.
  const claimed: [number, number][] = [];
  const overlaps = (at: number, end: number) => claimed.some(([s2, e2]) => at < e2 && s2 < end);
  for (const candidate of byLength) {
    const needle = `@${candidate.name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at === -1) break;
      const end = at + needle.length;
      // The character after the name must not continue it, or "@Dana" would
      // match inside "@Danae" and notify the wrong person.
      const after = text[end];
      if ((after === undefined || !/[A-Za-z0-9'-]/.test(after)) && !overlaps(at, end)) {
        found.add(candidate.id);
        claimed.push([at, end]);
        break;
      }
      from = at + 1;
    }
  }
  return [...found];
}

// What became of the mentions in a comment (SECURITY.md R3).
//
// A mention used to notify whoever it named, member or not — and a mention
// notification carries the page's TITLE in its subject and the comment's full
// TEXT in its body, delivered by email. So `@`-ing somebody with no role in a
// restricted collection mailed them the two things the collection exists to
// keep from them. The subject and the body are the leak; the notification is
// the delivery mechanism.
//
// Three answers were available and this is why this one was chosen:
//
//   - REFUSE THE COMMENT. Disproportionate: it throws away writing over an
//     addressing mistake, and it makes a restricted collection's membership
//     probeable one `@` at a time from an error message.
//   - NOTIFY WITHOUT CONTENT. Still leaks — that a page exists, that they were
//     named on it — and produces a notification nobody can act on: a link the
//     recipient cannot open with no way to know whether it matters.
//   - WITHHOLD, AND TELL THE COMMENTER. What happens now. The comment lands in
//     full, the mention stays in the text, no notification is written, and the
//     response names the actors who were not notified. "Mention someone to
//     bring them in" stays a workflow — it just becomes a deliberate one,
//     where the commenter is told to go and grant access rather than believing
//     they have already summoned somebody.
//
// The withheld ids are on the `comment.create` audit event too, so the record
// answers "who tried to pull an outsider into this collection" as well.
export interface MentionOutcome {
  /** Mentioned actors who hold a role here and were notified. */
  notified: string[];
  /** Mentioned actors with no role in this collection. Not notified. */
  withheld: { actorId: string; reason: 'no_access' }[];
}

/** What `create` returns: the stored comment, plus what became of its mentions. */
export interface CreatedComment extends Comment {
  mentions: MentionOutcome;
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

  create(
    actorId: string,
    pageId: string,
    input: { body: string; anchor?: Partial<CommentAnchor> | null },
  ): CreatedComment {
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

    // Mentions: an actor id, or a member's NAME — the second because nobody has
    // a colleague's UUID to hand, so the id-only form made the feature real and
    // unusable at the same time. Only candidates naming an existing actor
    // count, and the author is never notified about their own comment.
    const mentioned: Actor[] = [];
    const seenMentions = new Set<string>([actorId]);
    for (const candidate of parseMentions(body)) {
      if (seenMentions.has(candidate)) continue;
      try {
        const actor = this.host.getActor(candidate);
        seenMentions.add(actor.id);
        mentioned.push(actor);
      } catch {
        // not an actor id; plain text
      }
    }
    for (const id of resolveMentionNames(body, this.members(page.collectionId))) {
      if (seenMentions.has(id)) continue;
      seenMentions.add(id);
      mentioned.push(this.host.getActor(id));
    }
    // A mention notification carries the page title and the comment text, so
    // it may only reach somebody who could have read both anyway. See
    // MentionOutcome above for why this withholds rather than refuses.
    const notified: Actor[] = [];
    const withheld: { actorId: string; reason: 'no_access' }[] = [];
    for (const recipient of mentioned) {
      if (this.host.roleOf(recipient.id, page.collectionId)) notified.push(recipient);
      else withheld.push({ actorId: recipient.id, reason: 'no_access' });
    }

    this.audit(author, 'comment.create', {
      collectionId: page.collectionId,
      pageId,
      details: {
        commentId: id,
        anchored: anchor !== null,
        mentions: notified.map((a) => a.id),
        // Named only when there were any, so an ordinary comment's event does
        // not grow a field that is always empty.
        ...(withheld.length ? { mentionsWithheld: withheld.map((w) => w.actorId) } : {}),
      },
    });

    for (const recipient of notified) {
      this.notifier.send(recipient.id, {
        kind: 'mention',
        subject: `${actorNameForMessage(author)} mentioned you on "${page.title}"`,
        body,
        link: `/pages/${pageId}#comment-${id}`,
      });
    }

    // The page's OWNER is told, mentioned or not.
    //
    // §3 makes the owner accountable for keeping a page true, and a comment is
    // usually somebody telling them it is not. Until now that only arrived if
    // the commenter happened to know the owner's UUID — so the ordinary case,
    // "I read your policy and something is wrong with it", reached nobody and
    // sat on the page waiting to be stumbled over.
    //
    // Not sent when the owner wrote the comment, and not sent twice when they
    // were also mentioned: the mention is the more specific message and it has
    // already gone. Membership is checked exactly as it is for a mention — an
    // owner who has since lost their role in the collection is not mailed the
    // page's title and the comment's text.
    const ownerId = page.ownerId;
    if (ownerId && ownerId !== actorId && !notified.some((a) => a.id === ownerId)) {
      if (this.host.roleOf(ownerId, page.collectionId)) {
        this.notifier.send(ownerId, {
          kind: 'comment_added',
          subject: `${actorNameForMessage(author)} commented on "${page.title}"`,
          body,
          link: `/pages/${pageId}#comment-${id}`,
        });
      }
    }
    return { ...this.getComment(id), mentions: { notified: notified.map((a) => a.id), withheld } };
  }

  list(actorId: string, pageId: string): Comment[] {
    const page = this.page(pageId);
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to the collection is
    // told the page does not exist rather than which collection refuses them.
    notFoundIfStranger(this.host.roleOf(actorId, page.collectionId), `No such page: ${pageId}`);
    this.requireRole(actorId, page.collectionId, 'view');
    const rows = this.db
      .prepare(
        `SELECT c.*, a.kind AS author_kind FROM comments c
         JOIN actors a ON a.id = c.author_id
         WHERE c.page_id = ? ORDER BY c.created_at, c.rowid`,
      )
      .all(pageId) as Record<string, unknown>[];
    const sentBack = this.sendBackComments(pageId);
    return rows.map((r) => this.toComment(r, sentBack));
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
    return this.toComment(row, this.sendBackComments(row.page_id as string));
  }

  /**
   * The comments on this page that ARE send-backs, read off the events that
   * recorded them. A handful of rows on any real page, parsed in TypeScript
   * rather than picked apart with SQL JSON functions, because `details_json` is
   * this application's shape and not the database's.
   */
  private sendBackComments(pageId: string): Set<string> {
    const rows = this.db
      .prepare("SELECT details_json FROM audit_events WHERE page_id = ? AND action = 'page.send_back'")
      .all(pageId) as { details_json: string }[];
    const ids = new Set<string>();
    for (const r of rows) {
      const details = JSON.parse(r.details_json) as { commentId?: unknown };
      if (typeof details.commentId === 'string') ids.add(details.commentId);
    }
    return ids;
  }

  private commentWithPage(id: string): { comment: Comment; page: { collectionId: string } } {
    const comment = this.getComment(id);
    const page = this.page(comment.pageId);
    return { comment, page };
  }

  private toComment(row: Record<string, unknown>, sentBack: Set<string>): Comment {
    const quote = (row.anchor_quote as string) ?? null;
    return {
      sentBack: sentBack.has(row.id as string),
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

  private page(id: string): {
    id: string;
    collectionId: string;
    status: string;
    title: string;
    ownerId: string | null;
  } {
    const row = this.db
      .prepare('SELECT id, collection_id, status, title, owner_id FROM pages WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      status: row.status as string,
      title: row.title as string,
      ownerId: (row.owner_id as string) ?? null,
    };
  }

  /**
   * Everyone in a collection, for resolving `@Name`.
   *
   * Scoped to the collection on purpose. Resolving a name against the whole
   * actor directory would make the directory probeable one `@` at a time — type
   * a name, see whether the response says it was withheld — and the people
   * outside the collection are exactly the ones a mention refuses to notify
   * anyway (see MentionOutcome). So the set that can be NAMED is the set that
   * can be REACHED, and nothing is learned by guessing.
   */
  private members(collectionId: string): Actor[] {
    const rows = this.db
      .prepare('SELECT actor_id FROM collection_members WHERE collection_id = ?')
      .all(collectionId) as { actor_id: string }[];
    const out: Actor[] = [];
    for (const row of rows) {
      try {
        out.push(this.host.getActor(row.actor_id));
      } catch {
        // A membership row whose actor is gone is not a person to mention.
      }
    }
    return out;
  }

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      // One sentence, built in abilities.ts, and the same one the screen shows
      // before the click (USER-TESTING.md T4.4, second round).
      throw forbiddenRole(this.db, collectionId, role, needed);
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
