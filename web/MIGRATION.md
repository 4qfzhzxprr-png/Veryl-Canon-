# Migrating Canon's client to React

The working document for replacing `server/public/app.js`. It exists because
this migration spans many sessions and the expensive mistakes are all made in
the first week: how the two clients coexist, what a "migrated" route means, and
what has to be true before the switch is flipped for a paying customer.

## The shape of the problem

`server/public/app.js` is 10,735 lines. 9,109 of them are the eighteen view
functions below; the rest is the router, the API helper, markdown rendering and
chrome. Measured, not estimated — the number beside each view is the distance to
the next one, so nested render helpers are counted against the view that owns
them.

| View | Lines | Route | Phase |
|---|---:|---|---|
| `viewPage` | 1820 | `#/pages/:id` | 3 |
| `viewAsk` | 1739 | `#/ask`, `#/ask/:id` | 4 |
| `viewMap` | 795 | `#/map`, `#/collections/:id/map` | 4 |
| `viewQueue` | 711 | `#/queue` (+ `#/inbox`, `#/me`, `#/mine`) | 2 |
| `viewImportRun` | 666 | `#/imports/:id` | 2 |
| `viewCollectionMembers` | 575 | `#/collections/:id/members` | 4 |
| `viewAudit` | 487 | `#/audit` | 1 |
| `viewEditor` | 472 | `#/pages/:id/edit` | 4 |
| `viewSearch` | 423 | `#/search` | 2 |
| `viewSources` | 345 | `#/sources` | 1 |
| `viewHome` | 213 | `#/` | 1 |
| `viewGaps` | 201 | `#/gaps` | 1 |
| `viewCompare` | 185 | `#/pages/:id/compare/:a/:b` | 3 |
| `viewIdentity` | 126 | `#/identity` | 1 |
| `viewHistory` | 118 | `#/pages/:id/history` | 3 |
| `viewCollection` | 117 | `#/collections/:id` | 1 |
| `viewImports` | 69 | `#/imports` | 2 |
| `viewVersion` | 47 | `#/pages/:id/versions/:n` | 3 |

**Fourteen of the eighteen are migrated.** Four are left, all of them phase 4:
`ask`, `map`, `collection members` and the `editor`. That count — how many
routes are still handed to the original client — is the progress metric; see
"The deletion rule, corrected" below for why a shrinking `app.js` is not.

Line count is a proxy for effort and a bad one. `viewCompare` is 185 lines of
genuinely hard diff logic; `viewCollectionMembers` is 575 lines of form. The
phase column is ordered by risk and proof value, not by size.

## How the two clients coexist

**Two documents, one origin.** `/` serves the React client. `/classic.html`
serves today's client — the same `app.js` and `styles.css`, a second entry
document, no fork. Both share the session cookie because they share an origin,
so crossing between them keeps the user signed in.

**The React router owns the boundary.** `src/routes/index.ts` is the list of
migrated route patterns. A fragment that matches renders in React. A fragment
that does not is handed to the old client with a full navigation to
`/classic.html#<the same fragment>`. That list is the only place the boundary
exists — not scattered conditionals — and it shrinks to nothing by the end.

**Hash routing stays.** This is a decision, not an inheritance:

* deep links already sent by mail are `<CANON_BASE_URL>#/pages/…`. Path routing
  would break every link already in somebody's inbox, and mail cannot be
  recalled;
* a fragment never reaches the server, so `static.ts` needs no SPA catch-all.
  It keeps its strict filename allowlist instead of growing a rule that returns
  `index.html` for unknown paths — which would shadow the API's own 404s and is
  the usual way a static server starts serving HTML to a fetch;
* the strangler boundary can be drawn on the fragment, which is what makes the
  handoff above a one-line redirect.

**One flag, and it is per-customer for free.** `CANON_UI=react|classic`,
default `classic`. Because Canon is one process per organisation, the flag is
already a per-tenant rollout: turn it on for one instance, watch it, turn it on
for the next. There is no cohort machinery to build.

## Phase 0 — make it reachable

Nothing below matters until the built client is served. Four changes, all in
`server/src/static.ts` and its tests:

1. **Serve `assets/`.** The current filename check is
   `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, which rejects any path containing a
   separator — and Vite emits `assets/index-<hash>.js`. Allow exactly one
   `assets/` prefix, keep every other guarantee: no traversal, no dotfiles, no
   nested directories, extension must be in the content-type table.
2. **Cache hashed assets.** Everything is `cache-control: no-cache` today,
   which is correct for `app.js` at a stable URL and wasteful for
   `index-a3f9c1.js`. Hashed files under `assets/` get
   `max-age=31536000, immutable`; `index.html` stays `no-cache` or a deploy
   serves a stale document pointing at deleted chunks.
3. **Pick a document.** `/` serves `public-app/index.html` when
   `CANON_UI=react`, otherwise `public/index.html`. `/classic.html` always
   serves the old one.
4. **Document it.** `CONFIGURATION.md` is the reference of record for every
   environment variable; a flag that decides which client a customer sees
   cannot be discovered from source. `DEPLOY_RENDER.md` and `OPERATIONS.md` get
   the rollback sentence: unset the flag, redeploy, the old client is back.

The CSP needs no change. The production build has no `eval`, no inline script
and no external origin, so `default-src 'self'` already covers it — worth
re-verifying with a real build before the flag is flipped, because a plugin
that inlines a runtime chunk would break it silently.

**Done when:** a browser at `/` with the flag on loads the React client,
`#/collections` renders, `#/queue` lands on the old client still signed in, and
the flag off restores today's behaviour exactly.

## Phase 1 — read-only routes

`identity`, `home`, `collection` detail, `audit`, `gaps`, `sources`,
`imports` list. About 1,600 lines of old code, almost all of it lists, filters
and empty states.

Low risk by construction: nothing here writes. The value is that these eight
routes establish every pattern the remaining ten need — the auth gate, filters
held in the URL rather than in component state, cursor pagination, table
semantics that survive a screen reader, and the loading/empty/error triad that
`Async` already enforces.

`identity` goes first regardless of size. It is the gate; every other route is
unreachable without it, and it is where the session module-global in
`lib/api.ts` gets exercised for real.

**Done when:** a signed-in reader can move between all eight without ever
crossing to `/classic.html`.

**Done.** All seven routes are in `ROUTES`. The API layer was rewritten against
a running server in the process — see the note at the end of this document.

## Phase 2 — the daily surface

`queue` (with its three aliases), `search`, `imports` run detail. About 1,870
lines.

This is the phase that introduces **mutations**. The queue approves and rejects
proposals — the first place the React client changes the record — so it is
where the mutation pattern gets settled once: a wrapper that surfaces
`humanMessage()`, disables its control in flight, invalidates by query key
rather than refetching everything, and announces the outcome to a live region.
Get this wrong here and it is wrong in ten more places.

The queue is also the most-visited authenticated surface, which makes it the
honest test of whether the new client is actually faster.

**Optimistic updates: no, not here.** An approval that appears to succeed and
silently did not is a lie about the record. Show the pending state, wait for
the server, then move the row.

**Done when:** a reviewer can work a full day in the queue, and the badge count
in the nav is driven by the same query cache rather than a second fetch.

**Done**, with one correction the phase produced: the outcome announcement is
now published to a single live region in the shell rather than rendered by the
component that made the change. It had been inside the queue row — the approval
succeeded, the queue refetched, the row unmounted, and the sentence went with it
before anything read it out. A real browser found that; jsdom could not, because
the test held the request pending so the row never unmounted. **An announcement
must outlive whatever caused it.**

## Phase 3 — the record

`page` detail with its five panels (references, divergences, relations,
related, comments), `history`, `version`, `compare`. About 2,170 lines, and the
densest domain logic in the client outside `ask`.

The page view is not one route, it is six panels that load independently, and
that is how it should be built — each panel its own query and its own `Async`,
so a slow relations lookup does not hold the page's text hostage. That is a
genuine improvement over the current view, which resolves everything before it
renders anything.

Correctness matters more here than anywhere: a divergence rendered wrong is a
wrong answer *about the record*, which is the one thing this product cannot be
wrong about. Every panel gets tests against real fixture shapes, and the diff
in `compare` gets tests for the cases that are easy to get subtly wrong —
adjacent edits, moved blocks, a version that is byte-identical.

**Done when:** the panels match the old view affordance for affordance, and the
comparison view has been checked against real page histories rather than
invented ones.

**Done**, and the comparison is a real longest-common-subsequence diff
(`web/src/lib/diff.ts`, fourteen tests). A line-by-line walk reports every line
after a single inserted paragraph as changed, which on a forty-line page means
showing the reader thirty-nine false changes. Two bugs the tests caught: an
empty version was treated as one blank line, so every comparison against one
reported a removal that never happened; and the diff is bounded, because
O(n·m) on two 5,000-line versions freezes the tab of somebody who opened the
screen because they were in a hurry.

## Phase 4 — the hard ones

`editor`, `ask`, `map`, `collection members`. About 3,580 lines, and every one
of them has a reason to be last.

* **`editor`** — a text editor is where unsaved work gets lost. Needs draft
  persistence, a real leave guard, and conflict handling when the page moved
  under the author. Nothing about it is a straight port.
* **`ask`** — streaming answers with citations. The streaming seam does not fit
  the query cache and needs its own primitive; citation rendering has to stay
  exactly honest about what supports what.
* **`map`** — an SVG stage with its own interaction model, and the only place
  the CSP's `style-src 'unsafe-inline'` allowance is load-bearing (the `--h`
  and `--d` custom properties).
* **`collection members`** — permission grants. A form that gets this wrong
  gives somebody access they should not have.

All four are lazy-loaded route chunks. They are also the four where "port it"
is the wrong instruction — each deserves a look at whether the interaction is
right before it is rebuilt faithfully.

## Cross-cutting work, and when it has to land

| Foundation | Land by | Why then |
|---|---|---|
| Query key factory + invalidation map | Phase 1 | Keys invented per route cannot be invalidated coherently later. |
| Route table as data (`routes/index.ts`) | Phase 0 | It *is* the strangler boundary and the nav's source. |
| Focus + announcement on route change | Phase 1 | Retrofitting focus management across eighteen routes is worse than doing it once in the shell. |
| Mutation primitive | Phase 2 | First write. |
| Streaming primitive | Phase 4 | Only `ask` needs it; building it earlier is guessing. |
| Typed responses at the server seam | continuous | See below. |

### Typing the seam, route by route

`src/types/api.ts` says it plainly: the types are hand-written because Canon has
no OpenAPI document, which makes them a liability the day the server changes
without them. There is a better option available and it does not need a big
refactor.

`server/src/api.ts` declares `type Handler = (ctx) => unknown`. Make it generic
— `Handler<T>`, `route<T>(...)` — and give each route its response type as it is
migrated. The client then imports the type instead of mirroring it, and a server
change that breaks the client fails the build rather than a customer's page.

Doing this for all ~100 routes up front is a separate project. Doing it for the
route being migrated, in the same commit, costs almost nothing and the coverage
arrives with the migration.

## What "migrated" means

A route is not migrated until all of these are true. The last one is the one
that gets skipped, and skipping it is how a codebase ends up carrying two
clients forever.

- [ ] Every affordance of the old view is present, or its absence is a decision
      written down.
- [ ] Loading, empty and error states — error distinguishing "retry will help"
      from "it will not", which `ApiError` already knows.
- [ ] Reachable and operable by keyboard alone; focus lands somewhere sensible
      on arrival.
- [ ] Usable at 375px. Touch targets ≥44px, form controls ≥16px font-size (the
      iOS zoom guard).
- [ ] Tests for the edge states, not just the happy path.
- [ ] Added to `ROUTES` in `web/src/routes/index.ts`, at the address the
      ORIGINAL client uses — not a nicer one.

### The deletion rule, corrected

The first version of this document said a route was not migrated until its
`view*` function was deleted from `app.js`, and made a shrinking `app.js` the
progress metric. **That is wrong for the architecture actually built, and
following it would break the product.**

The strangler here is two whole documents. A reader handed to `/classic.html`
for an unmigrated route is then inside the original client, and navigating from
there to a *migrated* address — the front page, a collection — is served by the
original client's own view. Deleting `viewHome` the day `/` moves to React
would leave that reader on a blank page.

So the original client stays complete until it stops being reachable, which is
when the last route moves and `/classic.html` is withdrawn. `app.js` does not
shrink during phases 1–3; it is deleted whole at the end.

The metric that replaces it is **how many routes are still in the handoff** —
`ROUTES.length` against the eighteen views in the table above. That number is
visible, it moves every phase, and it cannot be gamed by adding a route to
React while leaving the old one serving.

The risk the original rule was guarding against is real and still needs
guarding: a codebase carrying two clients indefinitely. What actually prevents
that is finishing, and the check is that the handoff list gets shorter every
phase — not that a file gets smaller.

## Budgets and guardrails

* **Bundle.** Entry + shared chunks ≤ 200KB gzip. Route chunks ≤ 50KB gzip
  each. Currently 72KB total with one route. `chunkSizeWarningLimit: 250` in
  the Vite config is the noisy backstop, not the budget.
* **The handoff list gets shorter every phase.** `ROUTES.length` against the
  eighteen views in the table is the progress metric — see "The deletion rule,
  corrected" above for why `app.js` shrinking is not.
* **Server tests stay green throughout** (993 today). The static-serving change
  in phase 0 is the only server code this migration touches; if a phase needs
  more, that is worth noticing rather than absorbing.
* **The flag stays off in production** until phase 3 completes. Phases 1–2 are
  real but a customer crossing to `/classic.html` mid-task is a worse
  experience than never leaving it.

## The risks worth naming

**The boundary crossing is visible.** A full page load between the two clients
is a flash and a scroll reset. It is tolerable because it is temporary and
because it never loses work — but it is the reason the flag stays off until
most routes are across, rather than being turned on the moment phase 1 lands.

**Finishing is the hard part.** Both clients work, which is the whole point and
also the danger: a half-migrated Canon is not visibly broken, so nothing forces
the last phase. If the handoff list is not shorter after every phase, this has
failed quietly and should be stopped rather than continued.

**The API layer had never been run.** Before phase 1 the client was pointed at
`/api` — Canon mounts its routes at the root, so every call 404'd — and every
response type was inferred rather than read. The collection listing was assumed
to be `{collections: [...]}` and is a bare array; collections were given
`pageCount` and `role`, neither of which the server sends. The rule this bought:
**curl the endpoint, then write the type.** `web/src/lib/api.test.ts` is the
guard.

**`viewPage` and `viewAsk` are a third of the client between them.** Both were
grown, not designed. Rebuilding them faithfully preserves decisions nobody has
revisited in a year. Budget time to look at them before porting them.

**Canon's navigation is described outside Canon.** If the flag changes what
customers see, `APP_DOCS` in the Registry's executive assistant may describe a
Canon that no longer exists — and it answers "how do I…" with confidence. Check
it when the flag flips for real, and bump `APP_DOCS_VERSION` if it changes.
