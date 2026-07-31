// Core model per DATA-BACKBONE.md and CORE-PLAN.md.
// Structure over prose: everything a rule depends on lives here as data.

export type ActorKind = 'person' | 'agent';

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
    reviewed: true,
    allowsReviewDate: true,
    requiresReviewDate: true,
  },
  spec: {
    requiresOwner: true,
    requiresApprover: true,
    allowsEffectiveDate: false,
    reviewed: true,
    allowsReviewDate: true,
    requiresReviewDate: false,
  },
  plan: {
    requiresOwner: true,
    requiresApprover: false,
    allowsEffectiveDate: false,
    reviewed: true,
    allowsReviewDate: true,
    requiresReviewDate: false,
  },
  note: {
    requiresOwner: false,
    requiresApprover: false,
    allowsEffectiveDate: false,
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

export interface AuditEvent {
  id: number;
  at: string;
  actorId: string;
  actorKind: ActorKind;
  action: string;
  collectionId: string | null;
  pageId: string | null;
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
