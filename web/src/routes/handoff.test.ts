import { matchRoutes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ALIASES, ROUTES } from "./index";

/**
 * THE TEST THAT MAKES DELETING THE ORIGINAL CLIENT SAFE.
 *
 * While `/classic.html` is still shipped, an address this router does not match
 * falls through to it and keeps working — so a route nobody registered is
 * invisible. Delete the original client and that same address stops being a
 * fallback and becomes a broken page.
 *
 * So the precondition for deletion is not "the new client works". It is
 * "nothing still reaches the handoff", and that is what this asserts.
 *
 * **The list below is the original client's own dispatch table**, transcribed
 * from the `route()` function in `server/public/app.js` — every `parts[0] ===`
 * branch, in order. It is not a list of addresses that seemed likely. Reading
 * that function is exactly how `#/collections` got invented in phase 1 and how
 * `#/map` got missed in phase 4, so this file exists to make the reading
 * mechanical and checkable rather than a thing somebody did once.
 *
 * When the original client is finally deleted, THIS FILE STAYS. It becomes the
 * record of what Canon's addresses were on the day the old client went, and it
 * is what stops a later refactor quietly dropping one.
 */
const CLASSIC_ADDRESSES: { path: string; what: string }[] = [
  { path: "/", what: "viewHome — the collections list" },
  { path: "/identity", what: "viewIdentity" },
  { path: "/queue", what: "viewQueue" },
  { path: "/audit", what: "viewAudit" },
  { path: "/gaps", what: "viewGaps" },
  { path: "/sources", what: "viewSources" },
  { path: "/imports", what: "viewImports" },
  { path: "/imports/run-1", what: "viewImportRun — parts[1] present" },
  { path: "/search", what: "viewSearch" },
  { path: "/ask", what: "viewAsk(null)" },
  { path: "/ask/c-1", what: "viewAsk(parts[1])" },
  // The two that were missed. `#/map` is the WHOLE record — a different
  // endpoint and a different payload from a collection's map.
  { path: "/map", what: "viewMap(null) — every collection" },
  { path: "/map/c-1", what: "viewMap(parts[1])" },
  { path: "/collections/c-1", what: "viewCollection" },
  { path: "/collections/c-1/map", what: "viewMap(parts[1])" },
  { path: "/collections/c-1/members", what: "viewCollectionMembers" },
  { path: "/pages/p-1", what: "viewPage" },
  { path: "/pages/p-1/edit", what: "viewEditor" },
  { path: "/pages/p-1/history", what: "viewHistory" },
  { path: "/pages/p-1/versions/2", what: "viewVersion" },
  { path: "/pages/p-1/compare/1/2", what: "viewCompare" },
];

/** The three the original client REWRITES rather than routing. */
const CLASSIC_REWRITES = ["/inbox", "/me", "/mine"];

const patterns = ROUTES.map((route) => ({ path: route.path }));

function matches(pathname: string): boolean {
  const found = matchRoutes(patterns, pathname);
  // A splat or a catch-all would make everything "match" and make this test
  // meaningless. There is none in ROUTES, and this asserts a real pattern
  // matched the whole path rather than a prefix of it.
  return Boolean(found?.length) && found![found!.length - 1]!.pathname === pathname;
}

describe("nothing still reaches the handoff", () => {
  it.each(CLASSIC_ADDRESSES)(
    "React routes $path ($what)",
    ({ path }) => {
      expect(matches(path)).toBe(true);
    },
  );

  it.each(CLASSIC_REWRITES)("%s is rewritten rather than dropped", (from) => {
    expect(ALIASES[from]).toBeDefined();
    // ...and it rewrites to somewhere that actually exists.
    expect(matches(ALIASES[from]!)).toBe(true);
  });

  it("has no catch-all pattern, which would make the checks above vacuous", () => {
    expect(ROUTES.some((r) => r.path === "*" || r.path.includes("*"))).toBe(false);
  });

  it("still refuses an address the original client never served", () => {
    // The counter-check: if this passed, `matches` would be answering "yes" to
    // everything and every assertion above would be worthless.
    expect(matches("/not-a-canon-address")).toBe(false);
    expect(matches("/pages")).toBe(false);
  });

  it("registers every address exactly once", () => {
    const seen = ROUTES.map((r) => r.path);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
