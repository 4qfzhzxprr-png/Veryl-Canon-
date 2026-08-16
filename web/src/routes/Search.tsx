import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";
import { StatusTag } from "@/components/StatusTag";
import { api } from "@/lib/api";
import { plural, TYPE_LABELS } from "@/lib/format";
import type { SearchHit } from "@/types/api";

/**
 * Search, with the query in the URL.
 *
 * A result set somebody can send to a colleague is worth more than one they can
 * only describe, and Back undoing a search is what Back is for. The input is
 * held locally while they type and pushed to the URL when they stop — typing
 * straight into the URL would put a history entry behind every keystroke.
 */
export function Search() {
  const [params, setParams] = useSearchParams();
  const submitted = params.get("q") ?? "";
  const [typed, setTyped] = useState(submitted);

  // The URL is the source of truth: arriving on a link, or pressing Back, has
  // to move the box too.
  useEffect(() => setTyped(submitted), [submitted]);

  const query = useQuery({
    queryKey: ["search", submitted],
    queryFn: () => api.search(submitted),
    // No query, no request. `enabled` rather than an early return so the hook
    // order stays the same on every render.
    enabled: submitted.trim().length > 0,
  });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <h1 className="mb-1 font-sans text-title font-bold">Search</h1>
      <p className="mb-md text-ui text-muted">
        Everything you may read, by what it says as well as what it is called.
      </p>

      <form
        role="search"
        className="mb-lg flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = new URLSearchParams(params);
          if (typed.trim()) next.set("q", typed.trim());
          else next.delete("q");
          setParams(next);
        }}
      >
        <label htmlFor="q" className="sr-only">
          What are you looking for?
        </label>
        <input
          id="q"
          name="q"
          type="search"
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          placeholder="e.g. parental leave"
          // 16px, or iOS zooms the page the moment this is focused.
          className="min-h-[44px] flex-1 rounded-md border border-border bg-surface px-3 text-[16px] text-text placeholder:text-muted focus:border-action focus:outline-none focus:ring-2 focus:ring-action/40"
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      {!submitted.trim() ? (
        <EmptyState
          title="What are you looking for?"
          body="Search reads the text of every page you have access to, not just the titles. A page you cannot open never appears here — not even as a title."
        />
      ) : (
        <Async
          query={query}
          loadingLabel={`Searching for ${submitted}`}
          skeleton={
            <div className="flex flex-col gap-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} variant="card" label="Loading a result" />
              ))}
            </div>
          }
          isEmpty={(hits) => hits.length === 0}
          empty={
            <EmptyState
              title={`Nothing matches “${submitted}”`}
              body="Either nobody has written this down yet, or it is somewhere you cannot read. If it is the first, asking the question records a gap — which is how the missing page gets written."
            />
          }
        >
          {(hits) => (
            <>
              <p className="mb-2 text-meta text-muted" role="status">
                {plural(hits.length, "result")}
              </p>
              <ul className="flex flex-col gap-2">
                {hits.map((hit) => (
                  <li key={hit.pageId}>
                    <Hit hit={hit} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Async>
      )}
    </div>
  );
}

/**
 * The server's snippet contains `<mark>` around the words that matched.
 *
 * Rendered as text and re-marked here rather than injected as HTML. The snippet
 * is page content — somebody's writing — and `dangerouslySetInnerHTML` on it is
 * a script injection with the record as the vector. Splitting on the server's
 * own tags keeps the emphasis and keeps everything else inert.
 */
function Snippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(/(<mark>.*?<\/mark>)/g).filter(Boolean);
  return (
    <p className="text-meta text-muted">
      {parts.map((part, i) => {
        const matched = part.startsWith("<mark>");
        const text = matched ? part.slice(6, -7) : part;
        return matched ? (
          <mark key={i} className="rounded-sm bg-warn/25 px-0.5 text-text">
            {text}
          </mark>
        ) : (
          <span key={i}>{text}</span>
        );
      })}
    </p>
  );
}

function Hit({ hit }: { hit: SearchHit }) {
  return (
    <a href={`#/pages/${hit.pageId}`} className="card block p-md hover:border-action/40">
      <div className="flex flex-wrap items-start gap-2">
        <span className="min-w-0 flex-1 font-medium text-text">{hit.title}</span>
        <span className="shrink-0 text-meta text-muted">
          {TYPE_LABELS[hit.type] ?? hit.type}
        </span>
        {/* The standing it HOLDS, which is not always its status — a Canonical
            page with a revision in review is still one Canonical answer. */}
        <StatusTag status={hit.pageStanding ?? hit.status} />
      </div>
      <Snippet snippet={hit.snippet} />
      {hit.supersededBy ? (
        <p className="mt-1 text-meta text-warn">
          Superseded — a newer page has replaced this one.
        </p>
      ) : null}
    </a>
  );
}
