/**
 * Every query key in one place.
 *
 * Keys invented at each call site cannot be invalidated coherently: a mutation
 * that has to refresh "the collection this page is in" needs to name that key
 * from somewhere else in the tree, and a near-miss (`["collection", id]` vs
 * `["collections", id]`) fails silently by leaving stale data on screen. That
 * is a bug nobody reports, because the screen looks fine — it is just wrong.
 *
 * The shape is hierarchical on purpose, so a prefix invalidates a subtree:
 * `["collections"]` covers the listing and every collection under it.
 */
export const keys = {
  session: ["session"] as const,

  collections: {
    all: ["collections"] as const,
    one: (id: string) => ["collections", id] as const,
    tree: (id: string) => ["collections", id, "tree"] as const,
  },

  pages: {
    all: ["pages"] as const,
    one: (id: string) => ["pages", id] as const,
    versions: (id: string) => ["pages", id, "versions"] as const,
    version: (id: string, n: number) => ["pages", id, "versions", n] as const,
    comments: (id: string) => ["pages", id, "comments"] as const,
    references: (id: string) => ["pages", id, "references"] as const,
    relations: (id: string) => ["pages", id, "relations"] as const,
    related: (id: string) => ["pages", id, "related"] as const,
    divergences: (id: string) => ["pages", id, "divergences"] as const,
  },

  queue: ["queue"] as const,
  audit: (filter: unknown) => ["audit", filter] as const,
  auditSummary: (filter: unknown) => ["audit", "summary", filter] as const,
  gaps: (status: string | undefined) => ["gaps", status ?? "all"] as const,
  sources: ["sources"] as const,
  imports: {
    all: ["imports"] as const,
    one: (id: string) => ["imports", id] as const,
  },
  actors: ["actors"] as const,
  devActors: ["dev-actors"] as const,
};
