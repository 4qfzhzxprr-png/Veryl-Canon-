import { useQuery } from "@tanstack/react-query";
import { Async } from "@/components/Async";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { Source } from "@/types/api";

/**
 * The register of systems Canon may reach.
 *
 * Federation, not copying: a reference resolves against the system of record
 * every time it is read, so a page citing one is never quoting a stale number.
 * What matters on this screen is therefore the freshness window and the scope —
 * how old an answer may be before Canon refuses it, and which collections are
 * allowed to ask.
 */
export function Sources() {
  const query = useQuery({ queryKey: keys.sources, queryFn: api.sources });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <h1 className="mb-1 font-sans text-title font-bold">Sources</h1>
      <p className="mb-lg text-ui text-muted">
        Systems Canon may read from when a page cites them. A reference is resolved when it
        is read, so what a page shows is what the system of record says now.
      </p>

      <Async
        query={query}
        loadingLabel="Loading the source register"
        skeleton={
          <div className="flex flex-col gap-2" aria-hidden>
            {[0, 1].map((i) => (
              <Skeleton key={i} variant="card" label="Loading a source" />
            ))}
          </div>
        }
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="No source is registered"
            body="Until one is, a page can only say what somebody typed into it. A registered source lets a page cite a system of record — a benefits platform, an HR system — and show its current answer rather than a copy of last quarter's."
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2">
            {rows.map((source) => (
              <li key={source.id}>
                <SourceCard source={source} />
              </li>
            ))}
          </ul>
        )}
      </Async>
    </div>
  );
}

/** Minutes, hours or days — whichever makes the number readable. */
function freshness(ms: number): string {
  if (ms <= 0) return "always re-read";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${plural(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${plural(hours, "hour")}`;
  return `${plural(Math.round(hours / 24), "day")}`;
}

function SourceCard({ source }: { source: Source }) {
  return (
    <article className="card flex flex-col gap-2 p-md">
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="min-w-0 flex-1 text-ui font-medium text-text">{source.name}</h2>
        <span className="shrink-0 rounded-sm bg-surface-2 px-2 py-0.5 text-meta text-muted">
          {source.kind}
        </span>
      </div>

      {/* The address, wrapped rather than truncated: an operator checking which
          host a source points at is exactly the reader who needs the end of it. */}
      <p className="break-all text-meta text-muted">{source.baseUrl}</p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-meta sm:grid-cols-3">
        <div>
          <dt className="text-muted">Answers may be</dt>
          <dd className="text-text">{freshness(source.freshnessWindowMs)} old</dd>
        </div>
        <div>
          <dt className="text-muted">Authentication</dt>
          <dd className="text-text">{source.authMode || "none"}</dd>
        </div>
        <div>
          <dt className="text-muted">Reachable from</dt>
          <dd className="text-text">
            {/* Empty means Canon-wide, which is the opposite of "nothing" — a
                register that rendered an empty list as "no collections" would
                describe the most permissive setting as the most restrictive. */}
            {source.collectionIds.length === 0
              ? "every collection"
              : plural(source.collectionIds.length, "collection")}
          </dd>
        </div>
      </dl>

      {/* The server has already decided; this renders its answer rather than
          computing one. A control offered and then refused is the failure the
          abilities projection exists to prevent. */}
      {source.abilities.edit.why ? (
        <p className="text-meta text-muted">{source.abilities.edit.why}</p>
      ) : null}
    </article>
  );
}
