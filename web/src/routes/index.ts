import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * The strangler boundary, as data.
 *
 * Every route this client has taken over is listed here and nowhere else. A
 * fragment that matches one renders in React; a fragment that does not is
 * handed back to the original client, which still serves it exactly as it did
 * (see `Handoff`, and web/MIGRATION.md for the order the rest move in).
 *
 * It is one array rather than a set of conditions scattered through the router
 * because three things have to agree about which routes exist: the router, the
 * navigation, and the handoff. Two of those disagreeing is how a route ends up
 * either unreachable or rendered twice by two different clients.
 *
 * **The paths are the ORIGINAL client's paths.** They are not ours to choose:
 * every one of them is in somebody's bookmarks and in mail Canon has already
 * sent. The first draft of this list invented `/collections` for the front
 * page, which the original client answers at `/` — a reader following the tab
 * bar would have crossed over and landed somewhere else entirely.
 *
 * A route joins this list in the same change that deletes its `view*` function
 * from `server/public/app.js`. Adding it here while leaving the old one in
 * place is how a codebase ends up carrying two clients indefinitely.
 */
export interface RouteDef {
  /** A react-router path, matched against the hash fragment. */
  path: string;
  component: LazyExoticComponent<ComponentType>;
  /** The document title, and what is announced on arrival. */
  title: string;
  /** Reachable without an actor. Only the door is. */
  open?: boolean;
}

const route = (
  path: string,
  title: string,
  load: () => Promise<{ default: ComponentType }>,
  open = false,
): RouteDef => ({ path, title, component: lazy(load), ...(open ? { open } : {}) });

export const ROUTES: RouteDef[] = [
  route("/identity", "Sign in", () =>
    import("./Identity").then((m) => ({ default: m.Identity })), true),
  route("/", "Collections", () =>
    import("./Collections").then((m) => ({ default: m.Collections }))),
  route("/collections/:id", "Collection", () =>
    import("./CollectionDetail").then((m) => ({ default: m.CollectionDetail }))),
  route("/audit", "Audit log", () =>
    import("./Audit").then((m) => ({ default: m.Audit }))),
  route("/gaps", "Gaps", () =>
    import("./Gaps").then((m) => ({ default: m.Gaps }))),
  route("/sources", "Sources", () =>
    import("./Sources").then((m) => ({ default: m.Sources }))),
  route("/imports", "Imports", () =>
    import("./Imports").then((m) => ({ default: m.Imports }))),
  route("/imports/:id", "Import run", () =>
    import("./ImportRun").then((m) => ({ default: m.ImportRun }))),
  route("/queue", "My queue", () =>
    import("./Queue").then((m) => ({ default: m.Queue }))),
  route("/search", "Search", () =>
    import("./Search").then((m) => ({ default: m.Search }))),

  // The record itself. Order matters inside a react-router <Routes>: the more
  // specific paths are matched by rank rather than by position, but keeping
  // them together here keeps the list readable.
  route("/pages/:id", "Page", () =>
    import("./Page").then((m) => ({ default: m.Page }))),
  route("/pages/:id/history", "History", () =>
    import("./History").then((m) => ({ default: m.History }))),
  route("/pages/:id/versions/:n", "Version", () =>
    import("./History").then((m) => ({ default: m.Version }))),
  route("/pages/:id/compare/:a/:b", "Comparison", () =>
    import("./Compare").then((m) => ({ default: m.Compare }))),
];

/**
 * Addresses that are the same request under another name.
 *
 * `#/inbox`, `#/me` and `#/mine` were the three other things people typed when
 * they went looking for their own work, and all three used to fall through to
 * the front page without a word (USER-TESTING.md T2.1). They rewrite rather
 * than being three more routes, so the address bar still says where you are —
 * and the rewrite REPLACES the history entry, or Back lands on the alias and
 * bounces forward again.
 */
export const ALIASES: Record<string, string> = {
  "/inbox": "/queue",
  "/me": "/queue",
  "/mine": "/queue",
};

/**
 * Where the original client lives.
 *
 * A second document on the same origin, so the session cookie carries across
 * and a handoff never signs anybody out. It is a fixed address rather than one
 * derived from a setting: this is the escape hatch, and an escape hatch that
 * depends on configuration is one that is missing when it is needed.
 */
export const CLASSIC_DOCUMENT = "/classic.html";

/** The address in the original client for whatever the reader was asking for. */
export function classicUrlFor(hash: string): string {
  return `${CLASSIC_DOCUMENT}${hash || "#/"}`;
}
