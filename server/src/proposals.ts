import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { forbiddenRole, notFoundIfStranger } from './abilities.js';
import {
  Actor,
  ActorKind,
  actorNameForMessage,
  CanonError,
  DocType,
  Page,
  PageFields,
  Role,
  ROLE_RANK,
  TYPE_RULES,
} from './model.js';
import type { Notifier } from './notify.js';
import {
  normalizeBasis,
  recordAnchorDate,
  requireBasisForBackdating,
  validateEffectiveDateShape,
} from './effectivedate.js';

// Agent proposals (FEATURES.md §5, "Agent proposals"; the Next tier). This is
// the feature that completes the product's central claim: people and agents
// are co-authors of the same record, under the same rules.
//
// "An agent that spots a stale figure or a gap drafts a change and submits it
// for review. A certified agent working within its limits can publish directly
// where the workflow allows it, the same rule that applies to a trusted
// person." Both halves of that sentence matter, and the second one is already
// built: a Note publishes directly (CORE-PLAN.md Epic C), and an agent holding
// `write` and `edit` uses that path unchanged. Nothing here narrows it. What
// this file adds is the first half — the propose-and-review loop that Core
// deliberately deferred, so an agent can offer a change to material it may not
// publish on its own.
//
// THE MODEL: A PROPOSAL IS A REVIEWABLE CHANGE, NOT A DRAFT
//
// Core prevents write conflicts with a page lock: one draft per page, one
// editor at a time (store.ts, `editDraft`). If a proposal were a draft, an
// agent could take that lock and hold it, and a person wanting to edit their
// own page would be told to wait for a robot. That is the exact opposite of
// what "agents are collaborators, people stay the approvers" is supposed to
// mean, so a proposal is held in its OWN table, `page_proposals`, and touches
// `drafts` at no point in its life:
//
//   * one page carries any number of open proposals, from any number of
//     agents and people, all at once;
//   * a proposal NEVER takes the page lock, so a person keeps editing
//     normally with proposals open, and opening a proposal never waits on
//     whoever holds the draft;
//   * proposing is not publishing. A proposal changes nothing about what the
//     page says until a person accepts it.
//
// A proposal is a complete piece of proposed content — title, body, fields —
// written against the version it was based on (`base_version`), with a
// rationale, in one of four states: `open`, `accepted`, `rejected`,
// `superseded`.
//
// RATIONALE IS REQUIRED (design requirement 2)
//
// A proposal without a stated reason is not reviewable: the reviewer would
// have to reverse-engineer the agent's intent from a diff. "The source figure
// changed"; "this contradicts page X". Empty rationale, `invalid`, no
// exceptions — for people proposing as much as for agents.
//
// ACCEPTANCE REUSES THE REVIEW WORKFLOW; IT DOES NOT PARALLEL IT
//
// Accepting publishes the proposed content through the same `writeVersion`
// path `publish()` and `approve()` use (via `publishAcceptedProposal`, the one
// seam this file needs in store.ts), so the type's rules are honoured exactly
// as they always were:
//
//   * a Policy or Spec still needs an owner and a named approver before
//     anything can publish at all;
//   * accepting lands the page at Draft, never Canonical — precisely what
//     publishing does today, because the Canonical mark applies to reviewed
//     content. A reviewed type still reaches Canonical only through
//     `submitForReview` and its named approver's `approve`. Accepting a
//     proposal is therefore never a way round review;
//   * a Note publishes directly, as its workflow already allows.
//
// ATTRIBUTION (design requirement 4)
//
// The version acceptance writes is authored by the PROPOSER — the agent — and
// the accepting person is recorded on the proposal row (`decided_by`), in the
// version's note, and in the `proposal.accept` audit event. This is the one
// publish in Canon where the author and the acting actor differ, and it is the
// honest answer: the agent wrote the words, the person took responsibility for
// them being in the record. Four audit events cover the loop end to end:
// `proposal.create`, `proposal.accept`, `proposal.reject`, `proposal.supersede`.
//
// PERMISSIONS (design requirement 5)
//
// Proposing is the same intersection as everything else: the Registry's
// `write` action (applied at the door in agentauth.ts) AND Canon's `edit` role
// on the collection (applied here). Accepting and rejecting are a PERSON's
// act — an agent that may propose is not thereby able to publish. That is
// enforced twice, deliberately: agentauth.ts leaves the accept and reject
// routes out of its route table, so an agent's request is refused at the door
// as `route_not_available_to_agents`, and this file refuses an actor of kind
// `agent` outright, which also covers dev mode, where an agent's actor id can
// be presented in `X-Actor-Id` with no passport at all.
//
// CONFLICT (design requirement 7)
//
// A proposal is written against a base version. If the page has moved on —
// someone published, restored, or had a different proposal accepted — the
// proposed body no longer knows what it is replacing, and accepting it would
// silently discard the newer content. So acceptance re-checks the base version
// and refuses with `conflict`, marking the proposal `superseded` on the way
// out: the agent must look at the current record and propose again. `stale` is
// the observation (a computed flag, visible on read as soon as the page moves);
// `superseded` is the act, audited as `proposal.supersede`. Accepting one
// proposal supersedes the rest on that page for the same reason — they were
// all written against a record that has just moved.
//
// NOTIFICATIONS (design requirement 6)
//
// Following notify.ts's existing judgement rather than inventing a new one:
// - a new proposal notifies the page's owner, the person accountable for the
//   page being true, and where the page names no owner yet it fans out to the
//   members who could act on it (edit, approve, admin) — the same fallback
//   `reviewRequested` uses when a type names no approver;
// - a decision notifies the proposal's AUTHOR, because that is what
//   `draftApproved` and `draftSentBack` already do for the person whose work
//   was judged, and a rejected agent that is never told cannot re-propose. An
//   agent reads its own notifications through `GET /notifications` like anyone.
// Nobody else is notified on a decision: publishing notifies nobody today, and
// acceptance is a publish.

export const PROPOSALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS page_proposals (
  id            TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL REFERENCES pages(id),
  author_id     TEXT NOT NULL REFERENCES actors(id),
  rationale     TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  fields_json   TEXT NOT NULL,
  base_version  INTEGER,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'accepted', 'rejected', 'superseded')),
  created_at    TEXT NOT NULL,
  decided_by    TEXT REFERENCES actors(id),
  decided_at    TEXT,
  decision_note TEXT,
  version       INTEGER,
  superseded_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_page_proposals_page ON page_proposals(page_id, status);
`;

export type ProposalStatus = 'open' | 'accepted' | 'rejected' | 'superseded';

export interface Proposal {
  id: string;
  pageId: string;
  authorId: string;
  authorKind: ActorKind; // attribution: an agent's proposal is visibly agent work
  rationale: string; // why the record should change; never empty
  title: string;
  body: string;
  fields: PageFields;
  /** The published version this was written against; null on a page never published. */
  baseVersion: number | null;
  status: ProposalStatus;
  /**
   * Computed, never stored: an open proposal whose base version is no longer
   * the page's current one. A stale proposal can still be read and rejected;
   * accepting it is refused and supersedes it.
   */
  stale: boolean;
  createdAt: string;
  decidedBy: string | null; // the person who accepted or rejected it
  decidedAt: string | null;
  decisionNote: string | null; // the rejecter's comment, or the acceptor's note
  version: number | null; // the version acceptance produced
  supersededBy: string | null; // the proposal whose acceptance moved the page on
}

export interface ProposalInput {
  rationale: string;
  /** Anything omitted is carried over from the page's current published version. */
  title?: string;
  body?: string;
  fields?: PageFields;
}

/** What acceptance hands back: the settled proposal and the page it published. */
export interface ProposalDecision {
  proposal: Proposal;
  page: Page;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface ProposalHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
  /**
   * The one seam in store.ts: publish accepted content as a new version
   * authored by `authorId` (the proposer) on `actorId`'s (the accepting
   * person's) behalf. It runs the type rules and the same version-writing path
   * `publish()` uses, so nothing about history, search, or audit is special
   * here.
   */
  publishAcceptedProposal(
    actorId: string,
    authorId: string,
    pageId: string,
    content: { title: string; body: string; fields: PageFields; note: string | null },
  ): Page;
}

interface PageRow {
  id: string;
  collectionId: string;
  type: DocType;
  title: string;
  status: string;
  ownerId: string | null;
  approverId: string | null;
  effectiveDate: string | null;
  effectiveDateBasis: string | null;
  createdAt: string;
  currentVersion: number | null;
}

function now(): string {
  return new Date().toISOString();
}

export class ProposalService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: ProposalHost,
    private readonly notifier: Notifier,
  ) {}

  // ---- proposing -------------------------------------------------------

  create(actorId: string, pageId: string, input: ProposalInput): Proposal {
    const page = this.page(pageId);
    // Canon's half of the intersection. The Registry's half (`write`) was
    // applied at the door by agentauth.ts before this ran.
    this.requireRole(actorId, page.collectionId, 'edit');
    if (page.status === 'archived') throw new CanonError('workflow', 'Archived pages are read-only');

    const rationale = input.rationale?.trim();
    if (!rationale) {
      throw new CanonError(
        'invalid',
        'A proposal requires a rationale: state why the record should change (a proposal without a reason is not reviewable)',
      );
    }

    // Note what is NOT here: no read of `drafts`, no write to it, no lock
    // check. A proposal is orthogonal to whoever is editing the page.
    const author = this.host.getActor(actorId);
    const seed = this.seed(page);
    const fields = this.validateFields(page, { ...seed.fields, ...(input.fields ?? {}) }, seed.fields);
    const title = input.title?.trim() || seed.title;
    const body = input.body ?? seed.body;

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO page_proposals
           (id, page_id, author_id, rationale, title, body, fields_json, base_version, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, page.id, actorId, rationale, title, body, JSON.stringify(fields), page.currentVersion, now());

    this.audit(author, 'proposal.create', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: { proposalId: id, rationale, baseVersion: page.currentVersion },
    });

    // The page owner is the person accountable for the page being true, so a
    // proposal on it is their business first.
    const recipients = page.ownerId ? [page.ownerId] : this.membersWhoCouldAct(page.collectionId);
    this.fanOut(actorId, recipients, {
      kind: 'proposal_opened',
      subject: `Proposed change to "${page.title}"`,
      body: `${actorNameForMessage(author)} proposed a change to "${page.title}": ${rationale}`,
      link: `/pages/${page.id}#proposal-${id}`,
    });

    return this.get(id);
  }

  list(actorId: string, pageId: string, filter: { status?: ProposalStatus } = {}): Proposal[] {
    const page = this.page(pageId);
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to the collection is
    // told the page does not exist, byte-for-byte as a nonexistent id reads,
    // rather than a 403 naming the collection that holds it (P1). A member
    // refused a stronger act still meets the informative refusal below.
    notFoundIfStranger(this.host.roleOf(actorId, page.collectionId), `No such page: ${pageId}`);
    this.requireRole(actorId, page.collectionId, 'view');
    const rows = this.db
      .prepare(
        `SELECT p.*, a.kind AS author_kind FROM page_proposals p
          JOIN actors a ON a.id = p.author_id
          WHERE p.page_id = ? AND (? IS NULL OR p.status = ?)
          ORDER BY p.created_at, p.rowid`,
      )
      .all(pageId, filter.status ?? null, filter.status ?? null) as Record<string, unknown>[];
    return rows.map((r) => this.toProposal(r, page.currentVersion));
  }

  // ---- reviewing (a person's act) --------------------------------------

  accept(actorId: string, proposalId: string, input: { note?: string } = {}): ProposalDecision {
    const actor = this.requirePerson(actorId, 'accept');
    const proposal = this.get(proposalId);
    const page = this.page(proposal.pageId);
    this.requireRole(actorId, page.collectionId, 'edit');
    this.requireOpen(proposal);
    if (proposal.authorId === actorId) {
      // A person may propose too, and the same rule applies to them: someone
      // else takes the record's side of the decision.
      throw new CanonError('workflow', 'A proposal is accepted by someone other than its author');
    }
    if (page.status === 'archived') throw new CanonError('workflow', 'Archived pages are read-only');
    if (page.status === 'in_review') {
      throw new CanonError('workflow', 'This page is in review; settle the review before accepting a proposal');
    }

    // A proposal holds no lock — which is the whole point — so acceptance has
    // to be the polite one: publishing clears the draft, and clearing someone
    // else's draft to make room for a robot's suggestion is exactly the
    // interruption this design exists to avoid.
    const draft = this.db.prepare('SELECT editor_id FROM drafts WHERE page_id = ?').get(page.id) as
      | { editor_id: string }
      | undefined;
    if (draft) {
      const editor = this.host.getActor(draft.editor_id);
      throw new CanonError(
        'locked',
        draft.editor_id === actorId
          ? 'You have an unpublished draft on this page; publish or discard it before accepting a proposal'
          : `This page is being edited by ${editor.name}; accepting now would discard that draft`,
        { editorId: editor.id, editorName: editor.name },
      );
    }

    // The record moved on under this proposal: refuse rather than clobber.
    if (proposal.baseVersion !== page.currentVersion) {
      this.supersede(actor, proposal, { reason: 'base_version_moved' });
      throw new CanonError(
        'conflict',
        `This proposal was written against version ${proposal.baseVersion ?? 'none'} and the page is now at ` +
          `version ${page.currentVersion ?? 'none'}; it is superseded and must be proposed again against the current record`,
        {
          proposalId: proposal.id,
          baseVersion: proposal.baseVersion,
          currentVersion: page.currentVersion,
          status: 'superseded',
        },
      );
    }

    const note = input.note?.trim();
    // Attributed to the agent as author; the accepting person is recorded.
    // The type's rules run inside this call, so a Policy with no named
    // approver is refused here exactly as it is refused on publish.
    const published = this.host.publishAcceptedProposal(actorId, proposal.authorId, page.id, {
      title: proposal.title,
      body: proposal.body,
      fields: proposal.fields,
      note: note || `Proposal accepted by ${actor.name}: ${proposal.rationale}`,
    });

    const at = now();
    this.db
      .prepare(
        `UPDATE page_proposals SET status = 'accepted', decided_by = ?, decided_at = ?, decision_note = ?, version = ?
          WHERE id = ?`,
      )
      .run(actorId, at, note ?? null, published.currentVersion, proposal.id);

    this.audit(actor, 'proposal.accept', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: {
        proposalId: proposal.id,
        authorId: proposal.authorId,
        acceptedBy: actorId,
        version: published.currentVersion,
        status: published.status,
        rationale: proposal.rationale,
      },
    });

    const author = this.host.getActor(proposal.authorId);
    this.fanOut(actorId, [author.id], {
      kind: 'proposal_accepted',
      subject: `Proposal accepted: ${page.title}`,
      body: `${actorNameForMessage(actor)} accepted your proposed change to "${page.title}" as version ${published.currentVersion}.`,
      link: `/pages/${page.id}`,
    });

    // Every other open proposal on this page was written against a record
    // that has just moved. Say so, once, rather than letting each author
    // discover it by having an acceptance refused.
    for (const other of this.openOn(page.id, proposal.id)) {
      this.supersede(actor, other, { reason: 'page_moved', by: proposal.id });
    }

    return { proposal: this.get(proposal.id), page: published };
  }

  reject(actorId: string, proposalId: string, input: { comment: string }): Proposal {
    const actor = this.requirePerson(actorId, 'reject');
    const proposal = this.get(proposalId);
    const page = this.page(proposal.pageId);
    this.requireRole(actorId, page.collectionId, 'edit');
    this.requireOpen(proposal);
    // The same rule `sendBack` applies to an approver: a decision the author
    // cannot act on is not a decision.
    const comment = input.comment?.trim();
    if (!comment) {
      throw new CanonError('invalid', 'Rejecting a proposal requires a comment for its author');
    }

    this.db
      .prepare(
        `UPDATE page_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`,
      )
      .run(actorId, now(), comment, proposal.id);

    this.audit(actor, 'proposal.reject', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: { proposalId: proposal.id, authorId: proposal.authorId, rejectedBy: actorId, comment },
    });

    this.fanOut(actorId, [proposal.authorId], {
      kind: 'proposal_rejected',
      subject: `Proposal rejected: ${page.title}`,
      body: `${actorNameForMessage(actor)} rejected your proposed change to "${page.title}": ${comment}`,
      link: `/pages/${page.id}`,
    });

    return this.get(proposal.id);
  }

  // ---- internals -------------------------------------------------------

  // A proposal whose base has moved out from under it. Recorded as a decision
  // in its own right — `proposal.supersede` — because "nobody ever acted on
  // this" and "this was overtaken by the record" are different facts.
  private supersede(actor: Actor, proposal: Proposal, opts: { reason: string; by?: string }): void {
    const page = this.page(proposal.pageId);
    this.db
      .prepare(
        `UPDATE page_proposals SET status = 'superseded', decided_by = ?, decided_at = ?, superseded_by = ? WHERE id = ?`,
      )
      .run(actor.id, now(), opts.by ?? null, proposal.id);
    this.audit(actor, 'proposal.supersede', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: {
        proposalId: proposal.id,
        authorId: proposal.authorId,
        reason: opts.reason,
        baseVersion: proposal.baseVersion,
        currentVersion: page.currentVersion,
        ...(opts.by ? { supersededBy: opts.by } : {}),
      },
    });
    this.fanOut(actor.id, [proposal.authorId], {
      kind: 'proposal_superseded',
      subject: `Proposal superseded: ${page.title}`,
      body:
        `"${page.title}" has moved on since your proposal was written ` +
        `(base version ${proposal.baseVersion ?? 'none'}, now ${page.currentVersion ?? 'none'}). ` +
        `Read the current record and propose again.`,
      link: `/pages/${page.id}`,
    });
  }

  private openOn(pageId: string, exceptId: string): Proposal[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, a.kind AS author_kind FROM page_proposals p
          JOIN actors a ON a.id = p.author_id
          WHERE p.page_id = ? AND p.status = 'open' AND p.id != ?
          ORDER BY p.created_at, p.rowid`,
      )
      .all(pageId, exceptId) as Record<string, unknown>[];
    // The page's current version is irrelevant to these: they are about to be
    // superseded, and `stale` on the returned record is not read.
    return rows.map((r) => this.toProposal(r, null));
  }

  private get(id: string): Proposal {
    const row = this.db
      .prepare(
        `SELECT p.*, a.kind AS author_kind FROM page_proposals p
          JOIN actors a ON a.id = p.author_id WHERE p.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such proposal: ${id}`);
    const page = this.db.prepare('SELECT current_version FROM pages WHERE id = ?').get(row.page_id as string) as
      | { current_version: number | null }
      | undefined;
    return this.toProposal(row, page?.current_version ?? null);
  }

  private toProposal(row: Record<string, unknown>, currentVersion: number | null): Proposal {
    const status = row.status as ProposalStatus;
    const baseVersion = (row.base_version as number) ?? null;
    return {
      id: row.id as string,
      pageId: row.page_id as string,
      authorId: row.author_id as string,
      authorKind: row.author_kind as ActorKind,
      rationale: row.rationale as string,
      title: row.title as string,
      body: row.body as string,
      fields: JSON.parse(row.fields_json as string) as PageFields,
      baseVersion,
      status,
      stale: status === 'open' && baseVersion !== currentVersion,
      createdAt: row.created_at as string,
      decidedBy: (row.decided_by as string) ?? null,
      decidedAt: (row.decided_at as string) ?? null,
      decisionNote: (row.decision_note as string) ?? null,
      version: (row.version as number) ?? null,
      supersededBy: (row.superseded_by as string) ?? null,
    };
  }

  // Anything the proposal does not state is carried over from the published
  // record, exactly as a draft is seeded, so a one-figure change is a one-field
  // proposal rather than a re-transcription of the whole page.
  private seed(page: PageRow): { title: string; body: string; fields: PageFields } {
    const current = page.currentVersion
      ? (this.db
          .prepare('SELECT title, body, fields_json FROM page_versions WHERE page_id = ? AND number = ?')
          .get(page.id, page.currentVersion) as Record<string, unknown> | undefined)
      : undefined;
    if (!current) {
      return {
        title: page.title,
        body: '',
        fields: {
          ownerId: page.ownerId,
          approverId: page.approverId,
          effectiveDate: page.effectiveDate,
          effectiveDateBasis: page.effectiveDateBasis,
        },
      };
    }
    return {
      title: current.title as string,
      body: current.body as string,
      fields: JSON.parse(current.fields_json as string) as PageFields,
    };
  }

  // The same field-shape rules the draft path applies, applied at proposal
  // time so an agent hears about a bad field now rather than at acceptance,
  // when a person is waiting on it.
  //
  // `fields` here is already the merge of the proposal over the published
  // record, so `seeded` is passed alongside it to answer the one question the
  // merge has destroyed: is the effective date something this PROPOSAL is
  // changing? An agent that backdates a policy is the forgery of USER-TESTING.md
  // T1.5 with a passport, and is asked for a basis exactly as a person is; an
  // agent that leaves an inherited backdated date alone is proposing nothing
  // about it and is not made to answer for somebody else's record.
  private validateFields(page: PageRow, fields: PageFields, seeded: PageFields): PageFields {
    const type = page.type;
    const out: PageFields = { ...fields };
    if (fields.effectiveDate) {
      if (!TYPE_RULES[type].allowsEffectiveDate) {
        throw new CanonError('invalid', `Effective date applies only to Policy pages, not ${type}`);
      }
      validateEffectiveDateShape(fields.effectiveDate);
    }
    if (fields.effectiveDateBasis !== undefined) {
      // Normalised before the type is consulted, exactly as the draft path does
      // it: the seed carries `effectiveDateBasis: null` on every type, and the
      // absence of a value is not a claim.
      const basis = normalizeBasis(fields.effectiveDateBasis);
      if (basis && !TYPE_RULES[type].allowsEffectiveDate) {
        throw new CanonError('invalid', `A ${type} carries no effective date, so there is no basis for one to state`);
      }
      out.effectiveDateBasis = basis;
    }
    if (!out.effectiveDate && out.effectiveDateBasis) {
      throw new CanonError(
        'invalid',
        '"Where the effective date comes from" explains an effective date; this proposal states none',
      );
    }
    requireBasisForBackdating({
      next: out.effectiveDate ?? null,
      previous: seeded.effectiveDate ?? null,
      basis: out.effectiveDateBasis ?? null,
      anchor: recordAnchorDate(page.createdAt, this.firstPublishedAt(page.id)),
    });
    for (const key of ['ownerId', 'approverId'] as const) {
      const value = fields[key];
      if (value) this.host.getActor(value);
    }
    return out;
  }

  /** When this page's first version was published, or null if none ever was. */
  private firstPublishedAt(pageId: string): string | null {
    const row = this.db
      .prepare('SELECT created_at FROM page_versions WHERE page_id = ? ORDER BY number LIMIT 1')
      .get(pageId) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  // Accepting and rejecting are a person's act. agentauth.ts refuses an
  // agent at the door (the routes are not in its table); this is the second
  // lock, and the one that also holds in dev mode, where an agent's actor id
  // can arrive in X-Actor-Id with no passport behind it.
  private requirePerson(actorId: string, verb: 'accept' | 'reject'): Actor {
    const actor = this.host.getActor(actorId);
    if (actor.kind === 'agent') {
      throw new CanonError(
        'forbidden',
        `Only a person can ${verb} a proposal: an agent may propose, but publishing what it proposed is a person's act`,
        { reason: 'review_is_a_persons_act', actorKind: actor.kind },
      );
    }
    return actor;
  }

  private requireOpen(proposal: Proposal): void {
    if (proposal.status !== 'open') {
      throw new CanonError('workflow', `This proposal is already ${proposal.status}`, {
        proposalId: proposal.id,
        status: proposal.status,
      });
    }
  }

  private membersWhoCouldAct(collectionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT actor_id FROM collection_members WHERE collection_id = ? AND role IN ('edit', 'approve', 'admin')",
      )
      .all(collectionId) as { actor_id: string }[];
    return rows.map((r) => r.actor_id);
  }

  // Deduplicates, and never notifies the acting actor about their own act —
  // the same contract notify.ts's own fanOut keeps.
  private fanOut(
    byId: string,
    candidates: (string | null | undefined)[],
    message: { kind: 'proposal_opened' | 'proposal_accepted' | 'proposal_rejected' | 'proposal_superseded'; subject: string; body: string; link: string },
  ): void {
    for (const recipientId of new Set(candidates.filter((id): id is string => Boolean(id)))) {
      if (recipientId === byId) continue;
      this.notifier.send(recipientId, message);
    }
  }

  private page(id: string): PageRow {
    const row = this.db
      .prepare(
        `SELECT id, collection_id, type, title, status, owner_id, approver_id, effective_date,
                effective_date_basis, created_at, current_version
           FROM pages WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      type: row.type as DocType,
      title: row.title as string,
      status: row.status as string,
      ownerId: (row.owner_id as string) ?? null,
      approverId: (row.approver_id as string) ?? null,
      effectiveDate: (row.effective_date as string) ?? null,
      effectiveDateBasis: (row.effective_date_basis as string) ?? null,
      createdAt: row.created_at as string,
      currentVersion: (row.current_version as number) ?? null,
    };
  }

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      // One sentence, built in abilities.ts, and the same one the screen shows
      // before the click (USER-TESTING.md T4.4, second round).
      throw forbiddenRole(this.db, collectionId, role, needed);
    }
  }

  // Written here directly, as comments.ts does: the audit log is append-only
  // storage, and these events belong to the proposal loop rather than to any
  // store operation.
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
