// Core model per DATA-BACKBONE.md and CORE-PLAN.md.
// Structure over prose: everything a rule depends on lives here as data.

export type ActorKind = 'person' | 'agent';

// Core ships four fixed document types. Custom types come in a later tier.
export type DocType = 'policy' | 'spec' | 'plan' | 'note';
export const DOC_TYPES: readonly DocType[] = ['policy', 'spec', 'plan', 'note'];

// Page status in Core. `needs_update` joins in the Next tier with automated freshness.
export type PageStatus = 'draft' | 'in_review' | 'canonical' | 'archived';

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
}

export const TYPE_RULES: Record<DocType, TypeRules> = {
  policy: { requiresOwner: true, requiresApprover: true, allowsEffectiveDate: true, reviewed: true },
  spec: { requiresOwner: true, requiresApprover: true, allowsEffectiveDate: false, reviewed: true },
  plan: { requiresOwner: true, requiresApprover: false, allowsEffectiveDate: false, reviewed: true },
  note: { requiresOwner: false, requiresApprover: false, allowsEffectiveDate: false, reviewed: false },
};

// Structured fields carried on a page, stored as data, never parsed from prose.
export interface PageFields {
  ownerId?: string | null;
  approverId?: string | null;
  effectiveDate?: string | null; // ISO date, Policy only
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
  | 'workflow';

const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  locked: 423,
  invalid: 400,
  workflow: 422,
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
