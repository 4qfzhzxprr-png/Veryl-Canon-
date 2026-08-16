// Canon's HTTP contracts, as types.
//
// Hand-written rather than generated, because Canon's server has no OpenAPI
// document. That makes them a liability the day the server changes without
// them, and two things hold the liability down: they live in ONE file so a
// server change has one place to land, and the client narrows every response
// through a parser (lib/api.ts) rather than asserting — so a mismatch is a
// caught error at the call site rather than `undefined` surfacing three
// components later.
//
// **Every shape here was read off a running server, not inferred.** The first
// draft of this file was inferred, and every single shape in it was wrong: the
// collection listing was assumed to be `{collections: [...]}` and is a bare
// array, collections were assumed to carry `pageCount` and `role` and carry
// neither, and the whole client was pointed at `/api` when the server mounts
// its routes at the root. None of it had ever been run. Keep the discipline:
// curl the endpoint, then write the type.

// --------------------------------------------------------------------------
// Permission projections
// --------------------------------------------------------------------------

/**
 * One thing the asking actor may or may not do, and — when they may not — the
 * sentence explaining it, written by the server.
 *
 * The client NEVER computes permissions and never writes the refusal. It
 * renders what it is told, so the two cannot disagree in a way that silently
 * grants something, and a reason stays honest about which rule refused.
 */
export interface Ability {
  can: boolean;
  why: string | null;
}

/** The role names the server uses. Not the same words as the docs' prose. */
export type Role = "admin" | "steward" | "author" | "reader";

export interface CollectionAbilities {
  collectionId: string;
  role: Role | null;
  createPage: Ability;
  addMember: Ability;
  removeMember: Ability;
  assertRelation: Ability;
  runImport: Ability;
}

export interface PageAbilities {
  role: Role | null;
  edit: Ability;
  comment: Ability;
  submit: Ability;
  approve: Ability;
  sendBack: Ability;
  withdraw: Ability;
  archive: Ability;
  assertRelation: Ability;
}

// --------------------------------------------------------------------------
// Who is asking
// --------------------------------------------------------------------------

export interface Actor {
  id: string;
  name: string;
  kind: "person" | "agent";
}

/** `GET /auth/session`. */
export interface Session {
  /** Which door is open on this deployment. */
  mode: "sso" | "dev" | "none";
  sso: boolean;
  devAuth: boolean;
  authenticated: boolean;
  /** True for a cookie session. A cookie is ambient, so it identifies the
   *  caller on its own and must never travel beside an X-Actor-Id — the server
   *  refuses the pair. */
  viaCookie: boolean;
  actor: Actor | null;
  orgRole: string | null;
  csrfToken: string | null;
  csrfHeader: string;
  /** Where to send somebody to sign in, or null where no provider is set up. */
  loginUrl: string | null;
}

// --------------------------------------------------------------------------
// Collections and pages
// --------------------------------------------------------------------------

export interface Collection {
  id: string;
  name: string;
  description: string;
  /** Membership is required to see inside it. */
  restricted: boolean;
  createdAt: string;
  archivedAt: string | null;
  archivedPages: number;
  abilities: CollectionAbilities;
}

export type DocType = "policy" | "spec" | "plan" | "note";

export type PageStatus =
  | "draft"
  | "in_review"
  | "canonical"
  | "needs_update"
  | "archived"
  | "superseded";

/** A node of `GET /collections/:id/tree`, which nests. */
export interface PageNode {
  id: string;
  collectionId: string;
  parentId: string | null;
  position: number;
  type: DocType;
  title: string;
  status: PageStatus;
  pageStanding: string | null;
  ownerId: string | null;
  approverId: string | null;
  effectiveDate: string | null;
  reviewDate: string | null;
  currentVersion: number | null;
  createdAt: string;
  supersededBy: string | null;
  children: PageNode[];
}

/** The text of a page as published. */
export interface PageVersion {
  version: number;
  body: string;
  authorId: string;
  at: string;
  note: string | null;
}

/** `GET /pages/:id`. */
export interface PageDetail extends Omit<PageNode, "children"> {
  current: PageVersion | null;
  abilities: PageAbilities;
  /** Pages this one links to that the asker may not see. Named as a count
   *  rather than shown, so the page does not silently look shorter than it is. */
  withheldLinks: unknown[];
}

// --------------------------------------------------------------------------
// The audit log
// --------------------------------------------------------------------------

export interface AuditEvent {
  id: number;
  at: string;
  actorId: string;
  actorKind: "person" | "agent";
  action: string;
  collectionId: string | null;
  pageId: string | null;
  /** Joined at read time, so it is what the page is called NOW — see
   *  model.ts. Null where the event names no page, or the page is gone. */
  pageTitle: string | null;
  collectionName: string | null;
  details: Record<string, unknown>;
}

/**
 * `GET /audit/summary`. The screen cannot honestly draw the log without it: a
 * table showing twenty rows and saying nothing about the rest asserts a
 * completeness it does not have, and the action list has to come from the
 * record because a hard-coded one in the client was missing ten action types
 * the record actually writes while offering four it never does.
 */
export interface AuditSummary {
  matching: number;
  actions: { action: string; count: number }[];
}

// --------------------------------------------------------------------------
// Gaps
// --------------------------------------------------------------------------

export interface Gap {
  id: string;
  question: string;
  collectionId: string | null;
  timesAsked: number;
  firstAskedAt: string;
  lastAskedAt: string;
  nearest: { pageId: string; title: string }[];
  status: "open" | "resolved" | "dismissed";
  resolution: string | null;
  resolvedAt: string | null;
  /** Whether the record would answer this question TODAY. Derived by a dry-run
   *  probe with the asking actor's own permissions, and ABSENT where the probe
   *  was not run — which is not the same as false. */
  nowAnswers?: boolean;
}

export interface GapsView {
  scope: string;
  collections: { id: string; name: string }[];
  gaps: Gap[];
}

// --------------------------------------------------------------------------
// Federation
// --------------------------------------------------------------------------

export interface Source {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  authMode: string;
  freshnessWindowMs: number;
  /** Collections this source may be referenced from. Empty = Canon-wide. */
  collectionIds: string[];
  createdAt: string;
  abilities: { edit: Ability; delete: Ability };
}

// --------------------------------------------------------------------------
// Import
// --------------------------------------------------------------------------

export interface ImportCounts {
  found: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface ImportRun {
  runId: string;
  source: string;
  path: string;
  collectionId: string;
  type: DocType;
  actorId: string;
  hierarchy: "tree" | "breadcrumbs" | "flat";
  startedAt: string;
  finishedAt: string;
  counts: ImportCounts;
}
