import { useQuery } from "@tanstack/react-query";
import { Suspense, useEffect } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Skeleton } from "./components/Skeleton";
import { api, setSession } from "./lib/api";
import { classicUrlFor, ROUTES } from "./routes";

export function App() {
  // The session is fetched once and pushed into the fetch layer, which has no
  // hooks and needs it on every write. Everything downstream reads it from the
  // query cache like any other server state.
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const s = await api.session();
      setSession(s);
      return s;
    },
    staleTime: Infinity,
  });

  return (
    <HashRouter>
      <AppShell actor={session.data?.actor ?? null}>
        <Suspense fallback={<Skeleton variant="block" label="Loading this page" />}>
          <Routes>
            {/* Route-level splitting from the first route rather than as a
                later optimisation. Retrofitting it means untangling whatever
                imported what in the meantime; starting with it costs nothing. */}
            {ROUTES.map(({ path, component: Component }) => (
              <Route key={path} path={path} element={<Component />} />
            ))}
            {/* Everything not yet migrated still belongs to the original
                client, which serves it exactly as it always did. */}
            <Route path="*" element={<Handoff />} />
          </Routes>
        </Suspense>
      </AppShell>
    </HashRouter>
  );
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

  // Visible for the moment the navigation takes, and announced, because a
  // reader on a screen reader would otherwise hear nothing at all happen.
  return (
    <div className="mx-auto max-w-[900px] px-md py-2xl text-center" role="status">
      <p className="text-ui text-muted">Opening this part of Canon…</p>
    </div>
  );
}
