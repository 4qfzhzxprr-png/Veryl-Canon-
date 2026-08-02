// Core model per DATA-BACKBONE.md and CORE-PLAN.md.
// Structure over prose: everything a rule depends on lives here as data.

// Who can appear in the record's history. `system` is Canon itself, acting on
// its own clock — the freshness sweep and nothing else, today. It is a third
// kind rather than a special person because the audit log states the kind on
// every event, and an event that said `person` for work no person did would be
// a falsehood in the one place this product promises there are none. There is
// exactly one system actor and it cannot be signed in as; see system.ts, which
// argues the whole thing.
export type ActorKind = 'person' | 'agent' | 'system';

// Core ships four fixed document types. Custom types come in a later tier.
export type DocType = 'policy' | 'spec' | 'plan' | 'note';
export const DOC_TYPES: readonly DocType[] = ['policy', 'spec', 'plan', 'note'];

// Page status. `needs_update` joined in the Next tier with automated freshness
// (FEATURES.md §3 "Verification and freshness"): a Canonical page whose review
// date has passed is flipped to it by the sweep in freshness.ts, and returns to
// Canonical through the ordinary review workflow — there is no second path.
export type PageStatus = 'draft' | 'in_review' | 'canonical' | 'needs_update' | 'archived';

// Collection roles, ranked. A higher role implies every lower one.
export type Role = 'view' | 'comment' | 'edit' | 'approve' | 'admin';
export const ROLE_RANK: Record<Role, number> = {
  view: 1,
  comment: 2,
  edit: 3,
  approve: 4,
  admin: 5,
};

// What each type must carry before it can publish, and which types go
// through review. A Note publishes directly and never carries the
// Canonical mark; effective date exists only on Policy.
export interface TypeRules {
  requiresOwner: boolean;
  requiresApprover: boolean;
  allowsEffectiveDate: boolean;
  // Effective date (USER-TESTING.md T1.5). Two flags, for the same reason the
  // review date has two: "may carry one" and "must carry one" are different
  // questions, and only Policy answers yes to the second.
  //
  // Policy REQUIRES one. It is the field a regulator asks about first — not
  // "when was this written" but "when did this apply to us" — and a Canonical
  // policy that cannot answer it is a policy nobody can be held to or excused
  // by. The reasoning is the same one that makes a review date required here
  // and optional on a Spec: a Policy is the type whose whole purpose is to bind
  // behaviour over a period, and a period with no start is not a period. The
  // auditor found six Canonical policies with no effective date at all, and had
  // no way to tell them from six where the question had been considered and
  // genuinely had no answer.
  //
  // Spec, Plan and Note do not ALLOW one, so the question does not arise for
  // them; the flag is false three times over rather than absent, so the table
  // stays the single place the rules live.
  //
  // MIGRATION SAFETY, which is what makes this requirement legitimate rather
  // than merely strict. The requirement is on the ACT of publishing, checked in
  // `validateReadyToPublish` at the moment a person publishes or submits — it
  // is not a constraint on rows already in the record. A Canonical policy
  // written before this rule existed keeps its mark, keeps being cited, keeps
  // appearing in every register and answer, and is not retroactively invalid.
  // It is instead COUNTED: `collectionHealth` reports
  // `canonicalWithoutEffectiveDate`, so the six are a named exception an
  // auditor can sample rather than a silence. The next time somebody edits and
  // republishes one, they are asked the question once, and it is a question
  // whose answer they have.
  requiresEffectiveDate: boolean;
  reviewed: boolean;
  // Freshness (FEATURES.md §3). Which types may carry a review date, and which
  // must carry one before they can publish. Two flags rather than one because
  // the two questions are genuinely different, exactly as they are for the
  // effective date: a Spec may be dated for review without being made to be.
  //
  // Policy REQUIRES one — FEATURES.md §1 states it in those words ("A Policy
  // requires an owner, a review date, and an approver"), and a policy nobody
  // has promised to re-read is the thing freshness exists to prevent.
  // Spec and Plan ALLOW one: both reach Canonical, so both can go stale, but a
  // plan with a real end date and a spec that describes shipped behaviour are
  // ordinary, and forcing a date on them would teach people to type a year out
  // and forget it.
  // Note allows NONE. A Note never carries the Canonical mark, so it has no
  // standing to lose; a review date on one would be a promise about a page the
  // record never treated as official. "A Note requires nothing" (FEATURES.md §1)
  // is here read as "a Note carries nothing it cannot honour".
  allowsReviewDate: boolean;
  requiresReviewDate: boolean;
}

export const TYPE_RULES: Record<DocType, TypeRules> = {
  policy: {
    requiresOwner: true,
    requiresApprover: true,
    allowsEffectiveDate: true,
    requiresEffectiveDate: true,
    reviewed: true,
    allowsReviewDate: true,
    requiresReviewDate: true,
  },
  spec: {
    requiresOwner: true,
    requiresApprover: true,
    allowsEffectiveDate: false,
    requiresEffectiveDate: false,
    reviewed: true,
    allowsReviewDate: true,
    requiresReviewDate: false,
  },
  plan: {
    requiresOwner: true,
    requiresApprover: false,
    allowsEffectiveDate: false,
    requiresEffectiveDate: false,
    reviewed: true,
    allowsReviewDate: true,
    requiresReviewDate: false,
  },
  note: {
    requiresOwner: false,
    requiresApprover: false,
    allowsEffectiveDate: false,
    requiresEffectiveDate: false,
    reviewed: false,
    allowsReviewDate: false,
    requiresReviewDate: false,
  },
};

// Structured fields carried on a page, stored as data, never parsed from prose.
export interface PageFields {
  ownerId?: string | null;
  approverId?: string | null;
  effectiveDate?: string | null; // ISO date, Policy only
  // Where a backdated effective date comes from, in the words of the person who
  // set it: a committee minute, the system this page was migrated out of, the
  // import run that brought it in. Required — and only required — when the
  // effective date precedes the page's own first publication, which is the one
  // case the record cannot corroborate from anything it holds. See
  // effectivedate.ts, which owns the rule and explains why it is a declaration
  // rather than a refusal. A structured field like every other, so it is
  // versioned, attributed, carried in the field history, and attested.
  effectiveDateBasis?: string | null;
  // ISO date (YYYY-MM-DD). Data, never parsed from prose: the freshness sweep
  // and every structured query read this field, not a sentence in a body.
  reviewDate?: string | null;
}

export interface Actor {
  id: string;
  kind: ActorKind;
  name: string;
  email: string | null;
  registryRef: string | null; // Agent Passport reference; Canon stores no credentials
  createdAt: string;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  restricted: boolean; // restricted collections log page views to the audit log
  createdAt: string;
  archivedAt: string | null;
  /**
   * How many of this collection's pages are archived, and therefore absent
   * from the tree. Carried so the contents listing can reconcile itself with
   * the attestation register, which counts them: the two differ by exactly
   * this, and a reader should not have to guess that.
   */
  archivedPages?: number;
}

export interface Page {
  id: string;
  collectionId: string;
  parentId: string | null;
  position: number;
  type: DocType;
  title: string;
  status: PageStatus;
  ownerId: string | null;
  approverId: string | null;
  effectiveDate: string | null;
  effectiveDateBasis: string | null;
  reviewDate: string | null;
  currentVersion: number | null;
  createdBy: string;
  createdAt: string;
}

export interface PageVersion {
  pageId: string;
  number: number;
  title: string;
  body: string;
  fields: PageFields;
  authorId: string;
  note: string | null;
  createdAt: string;
}

export interface Draft {
  pageId: string;
  title: string;
  body: string;
  fields: PageFields;
  editorId: string; // the page lock: one editor at a time
  baseVersion: number | null;
  updatedAt: string;
}

// What is PENDING on a page In Review — the answer for every surface that has
// to name somebody while the page sits there.
//
// A page's owner, approver and dates live in two places, and they are two
// different facts. The `pages` row carries the PUBLISHED version's fields:
// history, written by `writeVersion`, and deliberately historical. The draft
// under review carries what is being PROPOSED. Between a submission that
// changes the approver and the approval that publishes it, the two name
// different people and both are true — about different questions.
//
// `CanonStore.approve` enforces the draft's, because approval publishes the
// draft. This projection is therefore what a screen must show while a page is
// in review; `pages.approver_id` answers "who approved what is published", and
// showing it as "the approver" mid-review names the wrong person.
export interface ReviewState {
  pageId: string;
  /** The draft's fields: what approval will publish, and what it enforces. */
  fields: PageFields;
  /**
   * The one actor `approve` accepts — or null where the type names no approver
   * (a Plan), in which case any holder of `approve` on the collection accepts
   * it. `namesApprover` tells the two apart, so "null" is never read as
   * "nobody knows".
   */
  approverId: string | null;
  namesApprover: boolean;
  /** Who holds the page lock on the draft under review. */
  editorId: string;
  /** Who submitted it and when, read back from the audit log. */
  submittedById: string | null;
  submittedAt: string | null;
  /** Whether the ASKING actor may withdraw it; see `withdrawFromReview`. */
  canWithdraw: boolean;
}

// An approver's refusal, still standing (USER-TESTING.md T4.3).
//
// A send-back is the last thing that happened to a page only until its author
// does something about it, so this is not a column: it is read from the audit
// log, and it stops being the answer the moment a resubmission, a withdrawal or
// a publish is written after it. See `CanonStore.sentBack`.
export interface SendBackNotice {
  /** The approver who sent it back. */
  byId: string;
  at: string;
  /** What they said, in full. The same text the author was emailed. */
  reason: string;
  /** The comment `sendBack` filed on the page carrying that text, if any. */
  commentId: string | null;
}

// One thing the asking actor may or may not do to a page, and — where they may
// not — the sentence that says who can.
//
// `why` is never a stack trace and never "403". It is written to be read by the
// person who was about to press the button: "Only Nadia Haddad, the named
// approver, can approve this."
export interface PageAbility {
  can: boolean;
  /** Null exactly when `can` is true. */
  why: string | null;
}

// The asking actor's standing on one page (USER-TESTING.md T4.4): what the
// server would accept from them right now, so a screen can stop offering what
// it is about to refuse. See `CanonStore.pageAbilities`, which states the one
// rule this projection lives under — it MIRRORS the checks, it never makes one.
export interface PageAbilities {
  /** The asking actor's effective role on this page's collection. */
  role: Role | null;
  edit: PageAbility;
  comment: PageAbility;
  submit: PageAbility;
  approve: PageAbility;
  sendBack: PageAbility;
  withdraw: PageAbility;
  archive: PageAbility;
}

export interface AuditEvent {
  id: number;
  at: string;
  actorId: string;
  actorKind: ActorKind;
  action: string;
  collectionId: string | null;
  pageId: string | null;
  /**
   * What the page and collection are called NOW, joined at read time rather
   * than stored on the event — a page renamed next year did not retroactively
   * carry that name when this happened, so this can never become part of the
   * immutable record. It is here because "where" reading the bare word "page"
   * on every row tells a reader scanning a thousand of them nothing.
   *
   * Absent on an event constructed by hand rather than read from the record,
   * and null where the event names no page or the page has since been deleted.
   * A reader who needs the title as it stood at that instant is asking a
   * point-in-time question; `GET /pages/:id/as-of` is where that is answered.
   */
  pageTitle?: string | null;
  collectionName?: string | null;
  details: Record<string, unknown>;
}

export type ErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'locked'
  | 'invalid'
  | 'workflow'
  // Authentication codes, carrying the Registry contract's error semantics
  // into Canon's envelope (REGISTRY-CONTRACT.md §5): an unknown passport is
  // 401, a lapsed or revoked certification is 403 (forbidden, above), and an
  // unreachable Registry is 503 — refused, never served from stale trust.
  | 'unauthenticated'
  | 'unavailable'
  // Rate limiting (ratelimit.ts, SECURITY.md R8): the request was well formed
  // and permitted, and the asker has simply asked for this too often. It is
  // deliberately its own code rather than `invalid` or `forbidden`, because
  // neither is true and a client must be able to tell "wait and retry" from
  // "never do this again". `retryAfterSeconds` travels in the details.
  | 'rate_limited';

const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  locked: 423,
  invalid: 400,
  workflow: 422,
  unauthenticated: 401,
  unavailable: 503,
  rate_limited: 429,
};

export class CanonError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CanonError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}
