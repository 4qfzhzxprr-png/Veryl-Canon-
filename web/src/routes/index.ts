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
 * A route joins this list in the same change that deletes its `view*` function
 * from `server/public/app.js`. Adding it here while leaving the old one in
 * place is how a codebase ends up carrying two clients indefinitely.
 */
export interface RouteDef {
  /** A react-router path, matched against the hash fragment. */
  path: string;
  component: LazyExoticComponent<ComponentType>;
  /** For the document title and the announcement made on arrival. */
  title: string;
}

export const ROUTES: RouteDef[] = [
  {
    path: "/collections",
    title: "Collections",
    component: lazy(() =>
      import("./Collections").then((m) => ({ default: m.Collections })),
    ),
  },
];

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
