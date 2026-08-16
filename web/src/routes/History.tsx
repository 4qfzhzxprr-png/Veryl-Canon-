import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { EmptyState } from "@/components/EmptyState";
import { Markdown } from "@/components/Markdown";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { formatAgo, formatDate, formatDateTime, plural } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { PageVersion } from "@/types/api";

/**
 * Every version this page has had.
 *
 * The history is the product. A knowledge base that can only show what it says
 * today cannot answer "what did our policy say in March", which is the question
 * that gets asked when it matters — so this screen's job is to make any two
 * versions comparable in two clicks, and to show WHY each one exists.
 */
export function History() {
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: keys.pages.versions(id),
    queryFn: () => api.versions(id),
  });
  // Two checkboxes rather than a pair of dropdowns: choosing "version 7 and
  // version 3" out of two long identical lists is a puzzle, and picking the
  // same one twice is possible in it.
  const [picked, setPicked] = useState<number[]>([]);

  const toggle = (n: number) =>
    setPicked((current) =>
      current.includes(n)
        ? current.filter((x) => x !== n)
        // Keeping the most recent two: a third click replaces the older of the
        // pair rather than being ignored, which is what people expect.
        : [...current, n].slice(-2),
    );

  return (
    <div className="mx-auto max-w-[820px] px-md py-lg sm:px-lg">
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href={`#/pages/${id}`}>
          ← Back to the page
        </a>
      </p>
      <h1 className="mb-1 font-sans text-title font-bold">History</h1>
      <p className="mb-lg text-ui text-muted">
        Every version, oldest change last. Nothing here is ever rewritten — a correction is
        a new version, not an edit to an old one.
      </p>

      <Async
        query={query}
        loadingLabel="Loading this page's history"
        skeleton={
          <div className="flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="card" label="Loading a version" />
            ))}
          </div>
        }
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="Nothing has been published yet"
            body="A version is written when a draft is approved. Until then there is a draft and no history."
          />
        }
      >
        {(versions) => (
          <>
            <p className="mb-2 text-meta text-muted">
              {plural(versions.length, "version")}
              {picked.length === 2
                ? " · two selected"
                : picked.length === 1
                  ? " · pick one more to compare"
                  : " · tick two to compare them"}
            </p>

            {picked.length === 2 ? (
              <div className="sticky top-16 z-10 mb-2">
                <a
                  className="inline-flex min-h-[44px] items-center rounded-md bg-action px-3 text-ui font-medium text-action-text"
                  href={`#/pages/${id}/compare/${Math.min(...picked)}/${Math.max(...picked)}`}
                >
                  Compare {Math.min(...picked)} with {Math.max(...picked)}
                </a>
              </div>
            ) : null}

            <ul className="flex flex-col gap-2">
              {/* Newest first: the question is almost always about a recent
                  change, and scrolling to the bottom to find it is a tax on
                  every reader to serve the rare one. */}
              {[...versions].reverse().map((version) => (
                <li key={version.number}>
                  <VersionCard
                    pageId={id}
                    version={version}
                    checked={picked.includes(version.number)}
                    onToggle={() => toggle(version.number)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </Async>
    </div>
  );
}

function VersionCard({
  pageId,
  version,
  checked,
  onToggle,
}: {
  pageId: string;
  version: PageVersion;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="card flex items-start gap-3 p-md">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 h-5 w-5 shrink-0 rounded border-border text-action focus:ring-2 focus:ring-action/40"
        aria-label={`Select version ${version.number} to compare`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <a
            className="text-ui font-medium text-action hover:underline"
            href={`#/pages/${pageId}/versions/${version.number}`}
          >
            Version {version.number}
          </a>
          <span className="text-meta text-muted">
            {formatAgo(version.createdAt) ?? ""} · {formatDateTime(version.createdAt)}
          </span>
        </div>

        {/* WHY it exists. Without the note a history is a list of timestamps,
            and the question people bring to it is never "when" alone. */}
        {version.note ? (
          <p className="mt-1 text-ui text-text">{version.note}</p>
        ) : (
          <p className="mt-1 text-ui text-muted">No note was left with this version.</p>
        )}

        {version.title !== "" ? (
          <p className="mt-1 text-meta text-muted">Titled &ldquo;{version.title}&rdquo;</p>
        ) : null}

        <p className="mt-1 text-meta text-muted">
          In force from {formatDate(version.fields.effectiveDate, "not stated")}
          {version.fields.effectiveDateBasis
            ? ` — ${version.fields.effectiveDateBasis}`
            : ""}
        </p>
      </div>
    </div>
  );
}

/** One published version, read on its own. */
export function Version() {
  const { id = "", n = "" } = useParams();
  const number = Number(n);
  const query = useQuery({
    queryKey: keys.pages.version(id, number),
    queryFn: () => api.version(id, number),
    enabled: Number.isFinite(number),
  });

  return (
    <div className="mx-auto max-w-[820px] px-md py-lg sm:px-lg">
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href={`#/pages/${id}/history`}>
          ← All versions
        </a>
      </p>

      <Async
        query={query}
        loadingLabel={`Loading version ${n}`}
        skeleton={<Skeleton variant="block" label="Loading this version" />}
      >
        {(version) => (
          <article>
            {/* Said before the text, not after it. Somebody who arrived on a
                link to an old version and read it as current is the mistake
                this banner exists to prevent. */}
            <p
              role="status"
              className="mb-md rounded-md bg-warn/10 px-3 py-2 text-ui text-warn"
            >
              This is version {version.number}, as published{" "}
              {formatDateTime(version.createdAt)}. It may not be what the page says now.
            </p>

            <h1 className="font-sans text-title font-bold">{version.title}</h1>
            {version.note ? (
              <p className="mt-1 text-ui text-muted">{version.note}</p>
            ) : null}

            <div className="mt-lg">
              <Markdown body={version.body} />
            </div>

            <p className="mt-lg">
              <a className="text-action hover:underline" href={`#/pages/${id}`}>
                See what this page says now
              </a>
            </p>
          </article>
        )}
      </Async>
    </div>
  );
}

