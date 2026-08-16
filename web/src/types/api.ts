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

/**
 * The role names the server uses — `model.ts`, `export type Role`.
 *
 * These are the WORDS THE SERVER USES, not the words the product's prose uses.
 * An earlier draft of this file guessed `admin | steward | author | reader`,
 * which shares exactly one member with the real list; a membership form built
 * on the guess would have offered three roles the server rejects outright and
 * omitted three it accepts.
 */
export type Role = "view" | "comment" | "edit" | "approve" | "admin";

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

/** The fields a version carries alongside its text. */
export interface VersionFields {
  ownerId: string | null;
  approverId: string | null;
  /** The day what it says began to apply — not the day it was written. */
  effectiveDate: string | null;
  /** Where that date comes from. The question an auditor asks about a
   *  backdated policy, and the one nobody can answer a year later. */
  effectiveDateBasis: string | null;
  reviewDate: string | null;
}

/**
 * One published version of a page.
 *
 * `number`, not `version`; `createdAt`, not `at`. Read off the server — the
 * inferred version of this interface had both wrong, which would have rendered
 * every version as "Version undefined" dated "Invalid Date".
 */
export interface PageVersion {
  pageId: string;
  number: number;
  title: string;
  body: string;
  fields: VersionFields;
  authorId: string;
  /** Why this version exists, in the author's or approver's words. */
  note: string | null;
  createdAt: string;
}

export interface Comment {
  id: string;
  pageId: string;
  authorId: string;
  authorKind: "person" | "agent";
  body: string;
  /** The passage it is attached to, where it is attached to one. */
  anchor: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  /** True when this comment IS a send-back — the reason a draft came back. */
  sentBack: boolean;
}

/** `GET /pages/:id`. */
export interface PageDetail extends Omit<PageNode, "children"> {
  current: PageVersion | null;
  effectiveDateBasis: string | null;
  abilities: PageAbilities;
  /** Pages this one links to that the asker may not see. Named as a count
   *  rather than shown, so the page does not silently look shorter than it is. */
  withheldLinks: unknown[];
}

// --------------------------------------------------------------------------
// The queue — one person's own work
// --------------------------------------------------------------------------

/**
 * A page as the queue's strands report one. Not `PageNode`: the query surface
 * the queue composes returns `pageId` rather than `id`, and carries four
 * derived flags the tree does not.
 */
export interface QueuedPage {
  pageId: string;
  collectionId: string;
  type: DocType;
  title: string;
  status: PageStatus;
  ownerId: string | null;
  reviewDate: string | null;
  updatedAt: string;
  /** The review date has passed. */
  pastReview: boolean;
  /** Effective before it was written down. */
  backdated: boolean;
  /** Backdated with no stated reason — the one an auditor asks about. */
  backdatedWithoutBasis: boolean;
  /** Canonical, but its effective date is in the future. */
  notYetInForce: boolean;
}

export interface Notice {
  id: string;
  kind: string;
  subject: string;
  body: string;
  /** Always `/pages/<id>`, sometimes with a comment fragment. */
  link: string | null;
  createdAt: string;
}

export interface QueueCounts {
  awaitingMyApproval: number;
  sentBackToMe: number;
  myPagesPastReview: number;
  myDrafts: number;
  conflictsOnMyPages: number;
  divergencesOnMyPages: number;
  accessRequests: number;
  notices: number;
  /**
   * Distinct pieces of work. Deliberately EXCLUDES notices — the outbox has no
   * read state, so a badge counting them would never go down, and a badge that
   * never goes down is ignored within a week.
   */
  total: number;
}

export interface WorkQueue {
  actorId: string;
  /** The day "past review" was judged against. */
  at: string;
  awaitingMyApproval: QueuedPage[];
  sentBackToMe: QueuedPage[];
  myPagesPastReview: QueuedPage[];
  myDrafts: QueuedPage[];
  /** Submitted by this actor and now waiting on somebody else. Uncounted: the
   *  badge means "waiting on you", and these are the opposite of that. */
  awaitingSomebodyElse: QueuedPage[];
  notices: Notice[];
  counts: QueueCounts;
  /** A strand hit its limit: these lists are a floor, not a total. */
  truncated: boolean;
}

// --------------------------------------------------------------------------
// Search
// --------------------------------------------------------------------------

export interface SearchHit {
  pageId: string;
  title: string;
  collectionId: string;
  type: DocType;
  status: PageStatus;
  pageStanding: string | null;
  reviewDate: string | null;
  ownerId: string | null;
  /** Contains `<mark>` around the matched words — the server's own emphasis. */
  snippet: string;
  supersededBy: string | null;
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

export type ImportOutcome = "imported" | "updated" | "skipped" | "failed";

export interface ImportFileResult {
  /** Path relative to the export root, POSIX separators. */
  file: string;
  outcome: ImportOutcome;
  pageId: string | null;
  title: string | null;
  parentFile: string | null;
  /** True when the body was written as a version. */
  published: boolean;
  /** Why it was skipped or failed, in the importer's own words. */
  reason: string | null;
}

/** What the run put on every page it landed, decided once for a whole corpus. */
export interface ResolvedImportFields {
  ownerId: string | null;
  approverId: string | null;
  reviewDate: string | null;
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

/** `GET /imports/:id` — the listing row, plus every file it read. */
export interface ImportRunDetail extends ImportRun {
  fields: ResolvedImportFields;
  files: ImportFileResult[];
}
