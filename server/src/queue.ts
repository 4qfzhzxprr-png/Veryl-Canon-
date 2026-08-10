import type { DatabaseSync } from 'node:sqlite';
import type { AccessRequest, AskedAccessRequest } from './access.js';
import type { Divergence, DivergenceFilter } from './divergence.js';
import { today } from './freshness.js';
import { Actor } from './model.js';
import type { Notification } from './notify.js';
import type { PageQuery, QueryResultPage } from './queries.js';
import type { OwnedConflict } from './relations.js';

// The queue: everything the record is waiting on one person for, on one screen.
//
// WHY THIS FILE EXISTS AT ALL
//
// USER-TESTING.md T2.1, and it is worth quoting rather than summarising. A
// Director of Compliance, asked to find the work waiting on him: "There isn't
// one. Five nav items, none scoped to me... I found my work by walking five
// collection sidebars, eyeballing 44 badges, and opening every one of those 44
// pages to read the Approver field — the sidebar doesn't show it. 25 were mine.
// Did I believe I'd found all of it? No, and I still don't." A new contributor
// discovered that her own Canonical policy had a conflict asserted against it
// by accident, from a list view she had opened for another reason.
//
// Every fact either of them needed was already in the record. None of it was
// ever asked FOR A PERSON. That is the whole of what this file adds: it asks.
//
// IT ADDS NO PERMISSION LOGIC, AND MUST NOT
//
// This is the one screen people will check every morning, which makes it the
// worst possible place for a leak — and a leak here would not look like a leak,
// it would look like a helpful list. So the queue composes read surfaces that
// already filter in their SELECT and writes no SQL over `pages` of its own:
//
//   * the four page strands are `QueryService.run`, whose candidate SELECT
//     joins `collection_members` for the asking actor (queries.ts);
//   * conflicts are `RelationService.listConflictsForOwner`, joined on the
//     membership of BOTH ends (relations.ts);
//   * source contradictions are `DivergenceService.list`, same join
//     (divergence.ts);
//   * notices are the actor's own outbox rows (notify.ts).
//
// The only SQL here is the visibility check over notification links below, and
// it is that same membership join written a fifth time rather than a new rule.
//
// ONE ACTOR, ALWAYS THEMSELVES
//
// There is no `queueFor(someoneElse)`. A queue assembled for another person
// would answer "what is Marcus behind on", which is a management report and a
// different feature with a different argument to make; and building it as a
// parameter here means one forgotten check turns this into it. The asking actor
// is the subject, full stop.
//
// WHY THE STRANDS ARE THESE SIX
//
// Each one is work THIS person can act on, and each maps to an act the server
// already has: approve, resubmit a send-back, re-certify a stale page you own,
// finish your draft, settle a contradiction. Nothing here is informational.
// What is deliberately NOT a strand:
//
//   * "pages I approved" — history, not work.
//   * "pages in collections I administer that are past review" — somebody
//     else's work, on the management-report side of the line above.
//   * open agent proposals awaiting a decision. They belong here on the merits
//     and are absent for an honest reason: `ProposalService.list` answers only
//     for one page, so there is no permission-filtered spanning read to compose,
//     and inventing one inside the queue is precisely the second query path
//     this file refuses to write. When proposals grow a spanning list, they
//     become a sixth strand and nothing else changes.
//   * unresolved comments mentioning me. The mention already produces a notice,
//     and notices are rendered below; a structured "comments addressed to me"
//     read does not exist yet.

/**
 * How many rows any one strand returns. Small on purpose: a queue is a screen
 * somebody reads, and the honest answer to "you have 900 things" is the count,
 * not 900 rows. `truncated` says when a strand hit it, exactly as record
 * health's `truncated` does.
 */
export const QUEUE_STRAND_LIMIT = 100;

/** How many of the most recent notices ride along. See NOTICES, below. */
export const QUEUE_NOTICE_LIMIT = 25;

/**
 * One open divergence, plus the title of the page it is on.
 *
 * The title is not on the divergence row and every other strand carries one, so
 * a queue built without it would be the only list on the screen that could not
 * say what it was about. It is read back through the same membership join that
 * selected the divergence — a second check of something already established, on
 * the principle that the cheap redundant check is the one you want on this
 * screen.
 */
export interface QueuedDivergence extends Divergence {
  pageTitle: string;
  collectionId: string;
}

/**
 * The counts, which are most of the value. Marcus's complaint was not that the
 * page was missing — it was that nothing told him 25 drafts were waiting, so a
 * number beside a nav item would have saved him the afternoon.
 *
 * `total` is the number of distinct pieces of work, and deliberately does NOT
 * include `notices`: the outbox has no read state (notify.ts has no `read_at`
 * and this read surface does not invent one), so a badge counting notices would
 * be a number that never goes down, and a badge that never goes down is
 * ignored within a week — which is how we got here.
 */
export interface WorkQueueCounts {
  awaitingMyApproval: number;
  sentBackToMe: number;
  myPagesPastReview: number;
  myDrafts: number;
  conflictsOnMyPages: number;
  divergencesOnMyPages: number;
  /**
   * People asking for access to a collection this actor administers. Counted,
   * unlike notices, because it is somebody waiting on a decision only this
   * person can make — which is the definition this queue uses for everything
   * it counts.
   */
  accessRequests: number;
  notices: number;
  total: number;
}

export interface WorkQueue {
  /** Whose queue this is. Always the asking actor; see the note above. */
  actorId: string;
  /** The day "past review" was judged against. */
  at: string;
  /** Pages In Review this actor can approve — the DRAFT's approver (queries.ts). */
  awaitingMyApproval: QueryResultPage[];
  /** Drafts an approver returned with a comment, still in this actor's hands. */
  sentBackToMe: QueryResultPage[];
  /** Pages this actor owns that are Needs Update, or whose review date has passed. */
  myPagesPastReview: QueryResultPage[];
  /** Drafts this actor holds and can still edit: work in progress. */
  myDrafts: QueryResultPage[];
  /**
   * Work this actor SUBMITTED that is now waiting on somebody else.
   *
   * Deliberately outside `counts` — see WAITING ON SOMEBODY ELSE below. The
   * badge means "waiting on you", and these are the opposite of that.
   */
  awaitingSomebodyElse: QueryResultPage[];
  /** `conflicts_with` assertions against a page this actor owns (relations.ts). */
  conflictsOnMyPages: OwnedConflict[];
  /** Open source contradictions on a page this actor owns (divergence.ts, §7). */
  divergencesOnMyPages: QueuedDivergence[];
  /**
   * Open requests for access to a collection this actor administers (access.ts).
   * THE ADMIN INBOX, and it is here rather than on a screen of its own for the
   * reason the notices are: this is the screen people check, and a request
   * nobody sees is worse than no request at all.
   */
  accessRequests: AccessRequest[];
  /**
   * What this actor has asked for and is still waiting on. Uncounted, exactly
   * like `awaitingSomebodyElse` and for the same reason — it is waiting on
   * somebody else, and a badge you cannot clear is ignored within a week.
   */
  accessAsked: AskedAccessRequest[];
  /** The outbox, at last rendered somewhere. See NOTICES below. */
  notices: Notification[];
  counts: WorkQueueCounts;
  /** A strand hit QUEUE_STRAND_LIMIT: these lists are a floor, not a total. */
  truncated: boolean;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface QueueHost {
  getActor(id: string): Actor;
  runQuery(actorId: string, query: PageQuery): QueryResultPage[];
  listDivergences(actorId: string, filter: DivergenceFilter): Divergence[];
  listConflictsForOwner(actorId: string, ownerId: string, options: { limit?: number }): OwnedConflict[];
  listNotifications(actorId: string): Notification[];
  listAccessRequests(actorId: string, opts?: { status?: 'open' | 'granted' | 'declined' | 'withdrawn' | 'all' }): AccessRequest[];
  listMyAccessRequests(actorId: string): AskedAccessRequest[];
}

/** `/pages/<id>` and `/pages/<id>#comment-…`: the only shape a notice links to. */
const PAGE_LINK = /^\/pages\/([^/#?]+)/;

export class QueueService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: QueueHost,
  ) {}

  /**
   * One person's queue. `on` exists for the same reason record health's does:
   * so a test can ask about a fixed day rather than about the day it runs.
   */
  queue(actorId: string, options: { on?: string } = {}): WorkQueue {
    this.host.getActor(actorId);
    const at = options.on ?? today();
    const limit = QUEUE_STRAND_LIMIT;

    // WAITING ON ME. `awaitingApprovalBy` is the read-side mirror of `approve`,
    // matched to it clause for clause (queries.ts) — in particular it reads the
    // DRAFT's approver, because `pages.approver_id` is the approver of the
    // PUBLISHED version and answers a different question. A queue built on that
    // column would list the wrong 25 pages and look exactly as right as this
    // one does, which is how T1.3 happened the first time.
    const awaitingMyApproval = this.host.runQuery(actorId, {
      awaitingApprovalBy: actorId,
      sort: 'updatedAt',
      direction: 'asc', // the longest-waiting first: it is a queue
      limit,
    });

    // SENT BACK TO ME. Someone with `approve` returned it with a comment saying
    // why, and it is a draft again in this actor's hands.
    const sentBackToMe = this.host.runQuery(actorId, { sentBackTo: actorId, sort: 'updatedAt', direction: 'asc', limit });

    // MINE AND OUT OF DATE, in two runs because they are two conditions the
    // filter cannot OR: the pages the sweep has already flipped, and the pages
    // whose review date has passed but which nothing has flipped yet — a
    // deployment with no freshness timer has only the second kind, and its
    // owners are exactly as behind (freshness.ts, and `pastReview` in
    // queries.ts). Merged here, deduplicated by page id.
    const flipped = this.host.runQuery(actorId, {
      ownerIds: [actorId],
      statuses: ['needs_update'],
      sort: 'reviewDate',
      direction: 'asc',
      limit,
    });
    const overdue = this.host.runQuery(actorId, {
      ownerIds: [actorId],
      statuses: ['canonical', 'needs_update'],
      reviewDateBefore: at,
      sort: 'reviewDate',
      direction: 'asc',
      limit,
    });
    const myPagesPastReview = mergePages(flipped, overdue).slice(0, limit);

    // MY DRAFTS. The page lock read as a filter: `editDraft` refuses a draft
    // somebody else holds, so a draft of mine is a page I can sit down and
    // finish. Statuses are named to exclude `in_review` — the draft under
    // review is still mine, but the move is the approver's, and it is already
    // in THEIR strand. Anything sent back is dropped here too: it is the same
    // page, and it appears once, in the strand that says what happened to it.
    const sentBackIds = new Set(sentBackToMe.map((p) => p.pageId));
    const myDrafts = this.host
      .runQuery(actorId, {
        draftHeldBy: actorId,
        statuses: ['draft', 'needs_update', 'canonical'],
        sort: 'updatedAt',
        direction: 'desc',
        limit,
      })
      .filter((p) => !sentBackIds.has(p.pageId));

    // WAITING ON SOMEBODY ELSE. The same lock, the one status the strand above
    // excludes.
    //
    // `myDrafts` names its statuses to leave out `in_review` because the MOVE
    // is the approver's and the page is already in their strand — which is
    // right about whose turn it is and wrong about what the author needs. An
    // author who submitted a policy on Tuesday saw "You have no drafts in
    // progress" on Wednesday: true, and it reads as "you have nothing in
    // flight" when in fact their work is sitting in somebody else's queue with
    // no way to find out whose or for how long.
    //
    // NOT counted in `total`, for the same reason `notices` is not: the badge
    // is a number of things waiting on THIS actor, and a submission is the one
    // thing on this screen that is explicitly waiting on somebody else.
    // Counting it would make the badge un-clearable by anything the actor can
    // do, and a badge you cannot clear is ignored within a week.
    const awaitingSomebodyElse = this.withDraftApprover(
      this.host.runQuery(actorId, {
        draftHeldBy: actorId,
        statuses: ['in_review'],
        sort: 'updatedAt',
        direction: 'asc', // longest-waiting first: it is the one you chase
        limit,
      }),
    );

    // CONTRADICTION, in both of the record's senses. A page-to-page conflict
    // somebody asserted (relations.ts) and a source disagreeing with the system
    // that owns the fact (divergence.ts, §7) are two different problems with
    // two different settlements, so they are two strands rather than one list
    // of "conflicts" whose rows mean different things.
    //
    // They are NOT deduplicated against the page strands. A policy that is both
    // past review and contradicted by another policy is two pieces of work, and
    // the second does not stop being work because the first exists.
    const conflictsOnMyPages = this.host.listConflictsForOwner(actorId, actorId, { limit });
    const divergencesOnMyPages = this.withPageTitles(
      actorId,
      this.host.listDivergences(actorId, { state: 'open', ownerId: actorId, limit }),
    );

    // NOTICES: the outbox, rendered.
    //
    // `GET /notifications` has existed and worked since the outbox shipped, the
    // freshness sweep writes a `review_due` row for every owner it flips, and
    // nothing in the SPA has ever called it — so the editor's promise about a
    // review date had to be narrowed to "a notice is written to the record and
    // nothing carries it to the owner". This is what carries it.
    //
    // They ride the queue rather than living in an inbox of their own, and the
    // reason is that they are not a separate population: every notice Canon
    // sends is ABOUT one of the strands above — a review requested, a draft sent
    // back, a page gone stale, a divergence opened. A second screen would be the
    // same work listed twice, in two places, each of which could be the one you
    // forgot to open. What a notice adds is the SENTENCE — who sent it back and
    // what they said — so it belongs beside the work, not in a room of its own.
    //
    // They are last, and they do not count toward the badge (see
    // WorkQueueCounts): the outbox has no read state to count against.
    // THE ADMIN INBOX. Composed like everything else here: `listAccessRequests`
    // returns only the collections this actor administers, and the queue adds
    // no rule of its own to that.
    const accessRequests = this.host.listAccessRequests(actorId, { status: 'open' }).slice(0, limit);
    const accessAsked = this.host.listMyAccessRequests(actorId).filter((r) => r.status === 'open');

    const notices = this.visibleNotices(actorId);

    const counts: WorkQueueCounts = {
      awaitingMyApproval: awaitingMyApproval.length,
      sentBackToMe: sentBackToMe.length,
      myPagesPastReview: myPagesPastReview.length,
      myDrafts: myDrafts.length,
      conflictsOnMyPages: conflictsOnMyPages.length,
      divergencesOnMyPages: divergencesOnMyPages.length,
      accessRequests: accessRequests.length,
      notices: notices.length,
      total:
        awaitingMyApproval.length +
        sentBackToMe.length +
        myPagesPastReview.length +
        myDrafts.length +
        conflictsOnMyPages.length +
        divergencesOnMyPages.length +
        accessRequests.length,
    };

    return {
      actorId,
      at,
      awaitingMyApproval,
      sentBackToMe,
      myPagesPastReview,
      myDrafts,
      awaitingSomebodyElse,
      conflictsOnMyPages,
      divergencesOnMyPages,
      accessRequests,
      accessAsked,
      notices,
      counts,
      truncated: [
        awaitingMyApproval,
        sentBackToMe,
        myPagesPastReview,
        myDrafts,
        // Uncounted, but a truncated list is still a list that is lying about
        // its own completeness — that is a rendering fact, not a badge fact.
        awaitingSomebodyElse,
        conflictsOnMyPages,
        divergencesOnMyPages,
      ].some((strand) => strand.length >= limit),
    };
  }

  /**
   * Overwrite `approverId` with the DRAFT's approver, for pages in review.
   *
   * `QueryResultPage.approverId` is `pages.approver_id` — the approver of the
   * PUBLISHED version, which answers a different question and is NULL on a page
   * that has never published. So the one strand whose whole purpose is "who has
   * my work" was reading null and the screen said "waiting on anyone who can
   * approve it" precisely when somebody had been named. A test caught it.
   *
   * The draft's `fields_json` is where `approve` reads its approver from, and
   * where `awaitingApprovalBy` matches — so this reads the same column the
   * enforcement does, and the author is told to chase the person who will
   * actually decide. Null stays null on a type that names no single approver
   * (a Plan), and the screen says so rather than inventing a name.
   */
  private withDraftApprover(pages: QueryResultPage[]): QueryResultPage[] {
    if (!pages.length) return pages;
    const stmt = this.db.prepare(
      "SELECT json_extract(fields_json, '$.approverId') AS approver_id FROM drafts WHERE page_id = ?",
    );
    return pages.map((page) => {
      const row = stmt.get(page.pageId) as { approver_id: string | null } | undefined;
      return { ...page, approverId: row?.approver_id ?? page.approverId };
    });
  }

  /**
   * The actor's most recent notices, minus any about a page they can no longer
   * see.
   *
   * A notification is addressed to one person and `listFor` returns only their
   * rows, so this is not the usual leak. It is a narrower one: a notice keeps
   * the page's TITLE in its subject line for as long as the row lives, and
   * membership can be withdrawn afterwards. Until now nothing rendered these,
   * so it did not arise; rendering them is what makes it arise, and the answer
   * is the same membership join every other read uses. Notices that name no
   * page pass through — none exist today, and dropping an unrecognised link
   * would be silently withholding something addressed to this person.
   */
  /**
   * Attach each divergence's page title, dropping any whose page this actor
   * cannot see. Nothing should be dropped — `listDivergences` already joined on
   * membership — and that is exactly why the check costs nothing to keep.
   */
  private withPageTitles(actorId: string, divergences: Divergence[]): QueuedDivergence[] {
    if (!divergences.length) return [];
    const ids = [...new Set(divergences.map((d) => d.pageId))];
    const pages = new Map(
      (
        this.db
          .prepare(
            `SELECT p.id, p.title, p.collection_id FROM pages p
               JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
              WHERE p.id IN (${ids.map(() => '?').join(', ')})`,
          )
          .all(actorId, ...ids) as { id: string; title: string; collection_id: string }[]
      ).map((r) => [r.id, r] as const),
    );
    const out: QueuedDivergence[] = [];
    for (const divergence of divergences) {
      const page = pages.get(divergence.pageId);
      if (!page) continue;
      out.push({ ...divergence, pageTitle: page.title, collectionId: page.collection_id });
    }
    return out;
  }

  private visibleNotices(actorId: string): Notification[] {
    const all = this.host.listNotifications(actorId).slice(0, QUEUE_NOTICE_LIMIT);
    const pageIds = [...new Set(all.map((n) => pageIdOfLink(n.link)).filter((id): id is string => id !== null))];
    if (!pageIds.length) return all;
    const visible = new Set(
      (
        this.db
          .prepare(
            `SELECT p.id FROM pages p
               JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
              WHERE p.id IN (${pageIds.map(() => '?').join(', ')})`,
          )
          .all(actorId, ...pageIds) as { id: string }[]
      ).map((r) => r.id),
    );
    return all.filter((n) => {
      const pageId = pageIdOfLink(n.link);
      return pageId === null || visible.has(pageId);
    });
  }
}

function pageIdOfLink(link: string): string | null {
  return PAGE_LINK.exec(link)?.[1] ?? null;
}

/** Two runs of one filter, merged into one list without repeating a page. */
function mergePages(...lists: QueryResultPage[][]): QueryResultPage[] {
  const seen = new Set<string>();
  const out: QueryResultPage[] = [];
  for (const list of lists) {
    for (const page of list) {
      if (seen.has(page.pageId)) continue;
      seen.add(page.pageId);
      out.push(page);
    }
  }
  // Both runs sort by review date ascending; the merge restores that across
  // them, so the page that has been out of date longest is at the top.
  return out.sort((a, b) => (a.reviewDate ?? '9999-12-31').localeCompare(b.reviewDate ?? '9999-12-31'));
}
