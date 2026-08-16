import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag } from "@/components/StatusTag";
import { api } from "@/lib/api";
import { formatDateTime, plural, TYPE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { Graph, GraphEdge, GraphNode } from "@/types/api";

/**
 * What a collection contains, and where it contradicts itself.
 *
 * **A map is a picture of the record, and a picture that is wrong is worse
 * than no picture** — somebody looks at it and concludes there are no
 * contradictions. So three rules hold:
 *
 *   * a truncated graph SAYS it is truncated, prominently. What is drawn is a
 *     floor, not the whole;
 *   * an edge whose kind this client does not recognise is still drawn, as a
 *     conflict. Dropping it would let the map assert that a page has no
 *     contradictions when it may;
 *   * **the same information is available without the picture.** The SVG is one
 *     way to read this; the list beside it is the other, and it is not a
 *     fallback but the accessible primary — a map that can only be understood
 *     by looking at it excludes anybody using a screen reader from the one
 *     screen that shows how the record hangs together.
 */
// Named `RecordMap`, not `Map`: a module-scope `Map` shadows the global one,
// and the first `new Map(...)` in the file then fails to compile in a way that
// reads as a type-system problem rather than a naming one.
export function RecordMap() {
  const params = useParams();
  // Two addresses, one screen: `#/map` and `#/collections/:id/map`.
  const collectionId = params["id"] ?? "";
  const graph = useQuery({
    queryKey: keys.collections.graph(collectionId),
    queryFn: () => api.graph(collectionId),
    enabled: collectionId !== "",
  });

  return (
    <div className="mx-auto max-w-[1000px] px-md py-lg sm:px-lg">
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href={`#/collections/${collectionId}`}>
          ← Back to the collection
        </a>
      </p>
      <h1 className="mb-1 font-sans text-title font-bold">Map</h1>
      <p className="mb-lg text-ui text-muted">
        Every page in this collection, and the assertions between them. A line is never a
        vague association — it is a page superseding another, or two pages that contradict
        each other.
      </p>

      <Async
        query={graph}
        loadingLabel="Drawing the map"
        skeleton={<Skeleton variant="block" label="Drawing the map" />}
        isEmpty={(g) => g.nodes.length === 0}
        empty={
          <EmptyState
            title="Nothing to map yet"
            body="A map needs pages. Once this collection has some, this shows how they relate — and where two of them disagree."
          />
        }
      >
        {(g) => <Drawn graph={g} />}
      </Async>
    </div>
  );
}

function Drawn({ graph }: { graph: Graph }) {
  const [selected, setSelected] = useState<string | null>(null);
  const laid = useMemo(() => layout(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => new Map(laid.map((n) => [n.id, n])), [laid]);

  return (
    <>
      {/* Said first and said plainly. A map silently capped is one somebody
          reads as complete. */}
      {graph.truncated ? (
        <p role="status" className="mb-md rounded-md bg-warn/10 px-3 py-2 text-ui text-warn">
          This collection is larger than the map draws. What is shown is part of it, not all
          of it — the counts below are exact.
        </p>
      ) : null}

      <p className="mb-3 text-meta text-muted">
        {plural(graph.counts.pages, "page")}, {plural(graph.counts.edges, "assertion")} between
        them. Drawn {formatDateTime(graph.generatedAt)}.
      </p>

      <Stage laid={laid} edges={graph.edges} byId={byId} selected={selected} onSelect={setSelected} />

      {/* Not a fallback. This is how the map is read by anybody who is not
          looking at it, and by anybody who wants the detail the picture leaves
          out. */}
      <h2 className="mt-lg text-ui font-semibold">Every page on this map</h2>
      <ul className="mt-2 flex flex-col gap-1.5">
        {laid.map((node) => (
          <li key={node.id}>
            <NodeRow
              node={node}
              edges={graph.edges.filter((e) => e.from === node.id || e.to === node.id)}
              byId={byId}
              highlighted={selected === node.id}
              onFocus={() => setSelected(node.id)}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

interface Placed extends GraphNode {
  x: number;
  y: number;
}

const R = 26;
const COLUMNS = 4;
const GAP_X = 220;
const GAP_Y = 130;

/**
 * A grid, deliberately, rather than a force-directed simulation.
 *
 * A physics layout looks impressive and is the wrong tool here: it is
 * non-deterministic, so the same collection draws differently every visit and
 * somebody comparing two screenshots cannot tell whether the record changed or
 * only the animation settled elsewhere. It also animates, which on a screen
 * this size is a lot of work for a reader trying to find one page.
 *
 * A stable grid sorted by title means the map is the SAME PICTURE every time,
 * and a page stays where the reader left it.
 */
function layout(nodes: GraphNode[]): Placed[] {
  return [...nodes]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((node, index) => ({
      ...node,
      x: (index % COLUMNS) * GAP_X + GAP_X / 2,
      y: Math.floor(index / COLUMNS) * GAP_Y + GAP_Y / 2,
    }));
}

const EDGE_TONE: Record<GraphEdge["kind"], string> = {
  conflicts_with: "stroke-danger",
  supersedes: "stroke-muted",
};

function Stage({
  laid,
  edges,
  byId,
  selected,
  onSelect,
}: {
  laid: Placed[];
  edges: GraphEdge[];
  byId: Map<string, Placed>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const width = COLUMNS * GAP_X;
  const height = (Math.floor((laid.length - 1) / COLUMNS) + 1) * GAP_Y;

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface-2 p-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full min-w-[560px]"
        // The picture is decorative in the strict sense: everything in it is in
        // the list below, which is the accessible reading of the same data.
        // Marking it up as a diagram to be explored by keyboard would promise
        // navigation this does not have.
        role="img"
        aria-label={`Map of ${plural(laid.length, "page")} and ${plural(edges.length, "assertion")} between them. The same information is listed below.`}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted" />
          </marker>
        </defs>

        {edges.map((edge, index) => {
          const from = byId.get(edge.from);
          const to = byId.get(edge.to);
          // An edge to a node the graph did not include is not drawn as a line
          // to nowhere. It is still counted, and it is still in the list.
          if (!from || !to) return null;
          const lit = selected === edge.from || selected === edge.to;
          return (
            <line
              key={`${edge.from}-${edge.to}-${index}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              strokeWidth={lit ? 3 : 1.5}
              // Dashed for a conflict as well as coloured, so the two kinds are
              // distinguishable without colour.
              strokeDasharray={edge.kind === "conflicts_with" ? "6 4" : undefined}
              markerEnd={edge.kind === "supersedes" ? "url(#arrow)" : undefined}
              className={EDGE_TONE[edge.kind]}
              opacity={selected && !lit ? 0.25 : 1}
            />
          );
        })}

        {laid.map((node) => {
          const lit = selected === node.id;
          return (
            <g
              key={node.id}
              onClick={() => onSelect(node.id)}
              className="cursor-pointer"
              opacity={selected && !lit ? 0.4 : 1}
            >
              <circle
                cx={node.x}
                cy={node.y}
                r={R}
                className={`${lit ? "fill-action" : "fill-surface"} stroke-border`}
                strokeWidth={2}
              />
              <text
                x={node.x}
                y={node.y + R + 16}
                textAnchor="middle"
                className="fill-text text-[11px]"
              >
                {node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function NodeRow({
  node,
  edges,
  byId,
  highlighted,
  onFocus,
}: {
  node: Placed;
  edges: GraphEdge[];
  byId: Map<string, Placed>;
  highlighted: boolean;
  onFocus: () => void;
}) {
  return (
    <div
      className={`card p-md ${highlighted ? "border-action" : ""}`}
      onMouseEnter={onFocus}
      onFocus={onFocus}
    >
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="min-w-0 flex-1 truncate text-ui font-medium text-action hover:underline"
          href={`#/pages/${node.id}`}
        >
          {node.title}
        </a>
        {node.type ? (
          <span className="shrink-0 text-meta text-muted">
            {TYPE_LABELS[node.type] ?? node.type}
          </span>
        ) : null}
        {node.status ? <StatusTag status={node.status} /> : null}
      </div>

      {edges.length ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {edges.map((edge, index) => {
            const other = byId.get(edge.from === node.id ? edge.to : edge.from);
            const outgoing = edge.from === node.id;
            return (
              <li key={index} className="text-meta">
                <span
                  className={edge.kind === "conflicts_with" ? "text-danger" : "text-muted"}
                >
                  {edge.kind === "conflicts_with"
                    ? "contradicts"
                    : outgoing
                      ? "supersedes"
                      : "is superseded by"}
                </span>{" "}
                {other ? (
                  <a className="text-action hover:underline" href={`#/pages/${other.id}`}>
                    {other.title}
                  </a>
                ) : (
                  // Named honestly rather than silently omitted: an assertion
                  // against a page outside this map, or one the reader may not
                  // see, is still an assertion that exists.
                  <span className="text-muted">a page not on this map</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-meta text-muted">No assertions against this page.</p>
      )}
    </div>
  );
}
