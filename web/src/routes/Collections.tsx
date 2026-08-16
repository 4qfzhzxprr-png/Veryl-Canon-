import { useQuery } from "@tanstack/react-query";
import { Async } from "@/components/Async";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import type { Collection } from "@/types/api";

/** The first migrated route, and the shape every other one should copy.
 *
 *  Note what is NOT here: no loading flag, no error flag, no try/catch, no
 *  effect, no local copy of the data. The whole screen is a query and a list,
 *  which is what it should have been all along. */
export function Collections() {
  const query = useQuery({ queryKey: ["collections"], queryFn: api.collections });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <h1 className="mb-1 font-sans text-title font-bold">Collections</h1>
      <p className="mb-lg text-ui text-muted">
        Every collection you can reach, and what is inside it.
      </p>

      <Async
        query={query}
        loadingLabel="Loading your collections"
        skeleton={
          <ul className="flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton variant="card" label="Loading a collection" />
              </li>
            ))}
          </ul>
        }
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="No collections yet"
            body="A collection groups the pages that answer one kind of question. The first one somebody writes becomes the canonical answer."
          />
        }
      >
        {(rows) => (
          <ul className="flex flex-col gap-2">
            {rows.map((c) => (
              <li key={c.id}>
                <CollectionCard collection={c} />
              </li>
            ))}
          </ul>
        )}
      </Async>
    </div>
  );
}

/** Small, presentational, and testable without a router or a server — which is
 *  the whole argument for components over a 10,000-line render function. */
export function CollectionCard({ collection }: { collection: Collection }) {
  return (
    <a
      href={`#/collections/${collection.id}`}
      className="card flex items-center gap-3 p-md transition-colors hover:border-action/40"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-text">{collection.name}</div>
        {collection.description ? (
          <div className="truncate text-meta text-muted">{collection.description}</div>
        ) : null}
      </div>
      <div className="shrink-0 text-meta text-muted">
        {collection.pageCount} {collection.pageCount === 1 ? "page" : "pages"}
      </div>
      {/* The caller's role HERE, as the server resolved it. The client never
          computes permissions — it renders what it is told, so a disagreement
          between the two cannot silently grant anything. */}
      {collection.role ? (
        <span className="shrink-0 rounded-sm bg-surface-2 px-2 py-0.5 text-meta text-muted">
          {collection.role}
        </span>
      ) : null}
    </a>
  );
}
