// Canon's HTTP contracts, as types.
//
// The client this replaces made every call through one untyped `api()` helper
// and read the results by hoping. These are hand-written rather than generated
// because Canon's server has no OpenAPI document — which makes them a
// liability the day the server changes without them. Two mitigations: they
// live in ONE file so a server change has one place to land, and the client
// narrows every response through a parser (see lib/api.ts) rather than
// asserting, so a mismatch is a caught error rather than `undefined` surfacing
// three components later.

/** Who the caller is, and which door they came through. */
export interface Session {
  actor: Actor | null;
  /** True for a cookie session. A cookie is ambient, so it identifies the
   *  caller on its own and must never travel beside an X-Actor-Id — the server
   *  refuses the pair. */
  viaCookie: boolean;
  csrfToken: string | null;
  csrfHeader: string;
}

export interface Actor {
  id: string;
  name: string;
  kind: "person" | "agent";
}

export type Role = "reader" | "author" | "reviewer" | "administrator";

export interface Collection {
  id: string;
  name: string;
  description: string;
  /** The caller's effective role HERE, already resolved by the server. The
   *  client never computes permissions: it renders what it is told, so a
   *  disagreement between the two cannot silently grant anything. */
  role: Role | null;
  pageCount: number;
  updatedAt: string;
}

export type PageState = "draft" | "in_review" | "canonical" | "archived";

export interface PageSummary {
  id: string;
  title: string;
  state: PageState;
  collectionId: string;
  updatedAt: string;
  /** Set when the canonical version is older than its review interval. */
  stale: boolean;
}

export interface QueueItem {
  id: string;
  title: string;
  kind: "review_requested" | "changes_requested" | "divergence";
  collectionName: string;
  waitingSince: string;
}

export interface QueueCounts {
  total: number;
  reviewRequested: number;
  changesRequested: number;
  divergence: number;
}

export interface Queue {
  items: QueueItem[];
  counts: QueueCounts;
}
