import { useQuery } from "@tanstack/react-query";
import { Suspense, useEffect, useRef } from "react";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Skeleton } from "./components/Skeleton";
import { api, setSession } from "./lib/api";
import { rememberedActor } from "./lib/actor";
import { keys } from "./lib/queryKeys";
import { ALIASES, classicUrlFor, ROUTES } from "./routes";

/**
 * The session, learned once and pushed into the fetch layer.
 *
 * The remembered actor is applied BEFORE the query runs, not after: the fetch
 * layer needs the header on the very first call, and a session query that
 * settles afterwards would have sent every query on the first render
 * unauthenticated. On a real deployment `rememberedActor()` returns null and
 * the cookie does the work.
 */
function useSession() {
  const applied = useRef(false);
  if (!applied.current) {
    applied.current = true;
    const actor = rememberedActor();
    if (actor) {
      setSession({
        mode: "dev",
        sso: false,
        devAuth: true,
        authenticated: true,
        viaCookie: false,
        actor,
        orgRole: null,
        csrfToken: null,
        csrfHeader: "x-canon-csrf",
        loginUrl: null,
      });
    }
  }

  return useQuery({
    queryKey: keys.session,
    queryFn: async () => {
      const s = await api.session();
      // The server is the authority on a cookie session. Where it reports one,
      // it replaces whatever the dev picker remembered — carrying both an
      // ambient cookie and an X-Actor-Id is a pair the server refuses.
      if (s.viaCookie || s.actor) setSession(s);
      return s;
    },
    staleTime: Infinity,
  });
}

export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

function Shell() {
  const session = useSession();
  const remembered = rememberedActor();
  const actor = session.data?.actor ?? remembered;

  return (
    <AppShell actor={actor}>
      <Suspense fallback={<Skeleton variant="block" label="Loading this page" />}>
        <Routes>
          {Object.entries(ALIASES).map(([from, to]) => (
            <Route key={from} path={from} element={<Navigate to={to} replace />} />
          ))}
          {ROUTES.map(({ path, component: Component, title, open }) => (
            <Route
              key={path}
              path={path}
              element={
                <RouteFrame title={title}>
                  {open ? (
                    <Component />
                  ) : (
                    <RequireActor actor={actor} pending={session.isPending}>
                      <Component />
                    </RequireActor>
                  )}
                </RouteFrame>
              }
            />
          ))}
          <Route path="*" element={<Handoff />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

/**
 * The gate.
 *
 * Nothing but the door renders without somebody behind the request. Two things
 * it deliberately does not do: it does not decide what that actor may SEE —
 * every such decision stays on the server, where the audit trail is — and it
 * does not redirect while the session is still being fetched, because bouncing
 * a signed-in reader to the sign-in screen for the half-second before their
 * cookie is confirmed is worse than a moment of skeleton.
 */
function RequireActor({
  actor,
  pending,
  children,
}: {
  actor: { id: string } | null;
  pending: boolean;
  children: React.ReactNode;
}) {
  if (pending) return <Skeleton variant="block" label="Checking your sign-in" />;
  if (!actor) return <Navigate to="/identity" replace />;
  return <>{children}</>;
}

/**
 * Focus and a spoken title on every navigation.
 *
 * A single-page app replaces the document without the browser doing any of the
 * things a page load does, so by default a screen-reader user hears nothing and
 * a keyboard user's focus stays on the link they just followed — several
 * screens away from the content that replaced it. Both are fixed here, once,
 * rather than in eighteen route components.
 *
 * The first render is skipped: on a real page load the browser has already
 * announced the document and put focus at the top, and doing it again reads
 * everything twice.
 */
function RouteFrame({ title, children }: { title: string; children: React.ReactNode }) {
  const location = useLocation();
  const first = useRef(true);

  useEffect(() => {
    document.title = `${title} · Veryl Canon`;
    if (first.current) {
      // On a real page load the browser has already announced the document and
      // put focus at the top. Doing it again reads everything twice.
      first.current = false;
      return;
    }
    // `tabIndex={-1}` on <main> is what makes this land: focus moves there, the
    // heading is read, and the next Tab continues from the content rather than
    // from the top of the document.
    document.getElementById("main")?.focus();
  }, [location.pathname, title]);

  return <>{children}</>;
}

/**
 * Hand this route back to the original client.
 *
 * A real navigation to a second document, not a render — the two clients are
 * two applications, and the point of the strangler is that the unmigrated one
 * keeps running untouched rather than being half-reimplemented here. They share
 * an origin, so the session cookie goes with the reader and nobody is signed
 * out by crossing.
 *
 * `replace`, not `assign`: an entry in the history for the address we bounced
 * off would put Back on a page that immediately bounces forward again, and the
 * reader would be trapped.
 *
 * This only ever goes one way. The original client never redirects here, so
 * there is no pair of rules that can send somebody round in a circle — the
 * worst case is that a reader who crosses over stays on the old client until
 * they come back to a migrated address themselves.
 */
function Handoff() {
  useEffect(() => {
    window.location.replace(classicUrlFor(window.location.hash));
  }, []);

  return (
    <div className="mx-auto max-w-[900px] px-md py-2xl text-center" role="status">
      <p className="text-ui text-muted">Opening this part of Canon…</p>
    </div>
  );
}
