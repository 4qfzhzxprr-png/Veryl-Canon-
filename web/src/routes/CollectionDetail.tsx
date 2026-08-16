import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag } from "@/components/StatusTag";
import { api } from "@/lib/api";
import { plural, STATUS_LABELS, TYPE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { Collection, PageNode } from "@/types/api";

/**
 * One collection: what it holds, and under which standing.
 *
 * Two queries rather than one, and they load independently. The original
 * client awaited both before rendering anything, so a slow tree held the
 * collection's own name off the screen — which is the part that tells the
 * reader they are in the right place.
 */
export function CollectionDetail() {
  const { id = "" } = useParams();
  const collection = useQuery({
    queryKey: keys.collections.one(id),
    queryFn: () => api.collection(id),
  });
  const tree = useQuery({
    queryKey: keys.collections.tree(id),
    queryFn: () => api.tree(id),
  });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <Async
        query={collection}
        loadingLabel="Loading this collection"
        skeleton={<Skeleton variant="row" label="Loading this collection" className="mb-lg" />}
      >
        {(c) => <Header collection={c} />}
      </Async>

      <Async
        query={tree}
        loadingLabel="Loading the pages in this collection"
        skeleton={
          <ul className="mt-lg flex flex-col gap-1.5" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i}>
                <Skeleton variant="line" label="Loading a page" />
              </li>
            ))}
          </ul>
        }
        isEmpty={(nodes) => nodes.length === 0}
        empty={
          <EmptyState
            title="No pages yet"
            body="Pages are the unit of knowledge in Canon. Start with a Note for working material, or a Policy, Spec, or Plan when there is an owner ready to stand behind it."
          />
        }
      >
        {(nodes) => (
          <Contents nodes={nodes} archived={collection.data?.archivedPages ?? 0} />
        )}
      </Async>
    </div>
  );
}

function Header({ collection }: { collection: Collection }) {
  return (
    <header>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-sans text-title font-bold">{collection.name}</h1>
        {collection.restricted ? (
          <span
            className="rounded-sm bg-surface-2 px-2 py-0.5 text-meta text-muted"
            title="Extra scrutiny, not extra access control."
          >
            Restricted
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-ui text-muted">{collection.description || "No description."}</p>
      <nav className="mt-3 flex flex-wrap gap-2" aria-label="This collection">
        <a
          className="rounded-md border border-border px-3 py-2 text-ui hover:bg-surface-2"
          href={`#/collections/${collection.id}/members`}
        >
          Members
        </a>
        <a
          className="rounded-md border border-border px-3 py-2 text-ui hover:bg-surface-2"
          href={`#/collections/${collection.id}/map`}
        >
          Map
        </a>
      </nav>
    </header>
  );
}

function flatten(nodes: PageNode[]): PageNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/**
 * The standing a page actually HOLDS right now, which is not always its status.
 *
 * A Canonical page with a revision in review is one Canonical answer. Filing it
 * under In Review tells a browsing reader the collection has no official answer
 * when it has one — so `pageStanding` wins where the server supplies it.
 */
function standingOf(node: PageNode): string {
  return node.pageStanding ?? node.status;
}

function Contents({ nodes, archived }: { nodes: PageNode[]; archived: number }) {
  const flat = useMemo(() => flatten(nodes), [nodes]);

  const tally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of flat) {
      const standing = standingOf(node);
      counts.set(standing, (counts.get(standing) ?? 0) + 1);
    }
    return ["canonical", "needs_update", "in_review", "draft"]
      .filter((s) => counts.has(s))
      .map((s) => `${counts.get(s)} ${STATUS_LABELS[s]}`)
      .join(" · ");
  }, [flat]);

  return (
    <section className="mt-lg">
      <h2 className="text-ui font-semibold">Contents — {plural(flat.length, "page")}</h2>
      {tally ? <p className="mt-1 text-meta text-muted">{tally}</p> : null}

      {/* Two numbers on an examiner's desk that do not tie, with nothing to
          explain the difference, is a finding whatever the explanation turns
          out to be. Archived pages leave the tree, so this count and the
          attestation register's are about different populations — 82 against
          85 in the corpus a compliance director cross-footed. Neither was
          wrong and neither said so. */}
      {archived > 0 ? (
        <p className="mt-1 text-meta text-muted">
          {plural(archived, "archived page")}, not listed below — the attestation register
          counts {flat.length + archived} including them.
        </p>
      ) : null}

      <ul className="mt-3 flex flex-col">
        {nodes.map((node) => (
          <TreeRow key={node.id} node={node} depth={0} />
        ))}
      </ul>
    </section>
  );
}

function TreeRow({ node, depth }: { node: PageNode; depth: number }) {
  return (
    <li>
      <a
        href={`#/pages/${node.id}`}
        className="flex items-center gap-2 rounded-md px-2 py-2.5 hover:bg-surface-2"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        <span className="min-w-0 flex-1 truncate text-ui text-text">{node.title}</span>
        <span className="shrink-0 text-meta text-muted">{TYPE_LABELS[node.type] ?? node.type}</span>
        <StatusTag status={standingOf(node)} />
      </a>
      {node.children.length ? (
        <ul className="flex flex-col">
          {node.children.map((child) => (
            <TreeRow key={child.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
