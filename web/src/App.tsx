import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Skeleton } from "./components/Skeleton";
import { api, setSession } from "./lib/api";

// Route-level splitting from the first route rather than as a later
// optimisation. Retrofitting it means untangling whatever imported what in the
// meantime; starting with it costs nothing.
const Collections = lazy(() =>
  import("./routes/Collections").then((m) => ({ default: m.Collections })),
);

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
            <Route path="/" element={<Collections />} />
            {/* Everything not yet migrated still belongs to the original
                client. Rather than half-render it here, hand it back — the
                strangler's whole point is that an unmigrated route keeps
                working exactly as it did. */}
            <Route path="*" element={<Unmigrated />} />
          </Routes>
        </Suspense>
      </AppShell>
    </HashRouter>
  );
}

function Unmigrated() {
  return (
    <div className="mx-auto max-w-[900px] px-md py-2xl text-center">
      <p className="text-ui text-muted">This part of Canon has not moved yet.</p>
    </div>
  );
}
