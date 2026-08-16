import { useQuery } from "@tanstack/react-query";
import { Async } from "@/components/Async";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { formatAgo, formatDateTime, TYPE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { Collection, ImportCounts, ImportRun } from "@/types/api";

const SOURCE_LABELS: Record<string, string> = {
  confluence: "Confluence export",
  gdocs: "Google Docs export",
  folder: "Folder of files",
};

/**
 * What Canon has brought in from somewhere else, and what became of every file.
 *
 * The sentence that matters most on this screen is that imported pages arrive
 * as DRAFTS. An import is not a way to publish a corpus: nothing it lands
 * carries the Canonical mark, whoever ran it, and a reader who assumed
 * otherwise would trust several hundred pages nobody has reviewed.
 */
export function Imports() {
  const runs = useQuery({ queryKey: keys.imports.all, queryFn: api.imports });
  // Names, so a run reads as "into Benefits" rather than a UUID. Deliberately
  // not awaited together with the runs: a collection listing that fails is a
  // worse label, not a broken screen.
  const collections = useQuery({ queryKey: keys.collections.all, queryFn: api.collections });

  // A server built without the importer answers 404 here. That is a shape this
  // deployment does not have, not a fault to show a stack trace for.
  if (runs.isError && runs.error instanceof ApiError && runs.error.status === 404) {
    return (
      <Wrap>
        <EmptyState
          title="Importing is not available on this Canon"
          body="This server was built without the importer. Pages can still be written here, and a Canon that has it can import into a collection you both belong to."
        />
      </Wrap>
    );
  }

  return (
    <Wrap>
      <h1 className="mb-1 font-sans text-title font-bold">Imports</h1>
      <p className="mb-lg text-ui text-muted">
        Everything Canon has brought in from another system, and what became of every file.
        Imported pages arrive as drafts — nothing an import lands carries the Canonical
        mark, whoever ran it.
      </p>

      <Async
        query={runs}
        loadingLabel="Loading past imports"
        skeleton={
          <div className="flex flex-col gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="line" label="Loading an import run" />
            ))}
          </div>
        }
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="No import has been run"
            body="A Confluence space export or a folder of Google Docs exports arrives as draft pages, keeping the page tree where the export describes one. Every file gets an outcome you can read, and nothing becomes Canonical without passing through review."
          />
        }
      >
        {(rows) => (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-ui">
                <caption className="sr-only">Import runs, most recent first.</caption>
                <thead>
                  <tr className="border-b border-border text-left text-meta text-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">Run</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Outcome</th>
                    <th scope="col" className="py-2 font-medium">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((run) => (
                    <Row
                      key={run.runId}
                      run={run}
                      collection={collections.data?.find((c) => c.id === run.collectionId)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-md text-meta text-muted">
              Open a run to see every file it read, why any of them failed, and to run it
              again — a re-run skips the files that have not changed and retries the ones
              that did not land.
            </p>
          </>
        )}
      </Async>

      {/* The listing failing for any OTHER reason is a real error, and still
          gets said out loud rather than leaving an empty table. */}
      {runs.isError && !(runs.error instanceof ApiError && runs.error.status === 404) ? (
        <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
      ) : null}
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">{children}</div>;
}

function Row({ run, collection }: { run: ImportRun; collection: Collection | undefined }) {
  return (
    <tr className="border-b border-border/60 align-top">
      <td className="py-2.5 pr-3">
        <a className="text-action hover:underline" href={`#/imports/${run.runId}`}>
          {SOURCE_LABELS[run.source] ?? run.source} into {collection?.name ?? "a collection"}
        </a>
        <div className="text-meta text-muted">
          {TYPE_LABELS[run.type] ?? run.type} pages
        </div>
      </td>
      <td className="py-2.5 pr-3">
        <Counts counts={run.counts} />
      </td>
      <td className="whitespace-nowrap py-2.5">
        <div className="text-text">{formatAgo(run.startedAt) ?? "—"}</div>
        <div className="text-meta text-muted">{formatDateTime(run.startedAt)}</div>
      </td>
    </tr>
  );
}

/**
 * Every outcome, including the zeroes for failures.
 *
 * A run that shows "48 imported" and omits "2 failed" reads as a clean run. The
 * failure count is the one number on this row somebody has to act on, so it is
 * always present once anything failed, and it is coloured AND labelled — never
 * colour alone.
 */
function Counts({ counts }: { counts: ImportCounts }) {
  const parts: { label: string; value: number; tone: string }[] = [
    { label: "imported", value: counts.imported, tone: "text-text" },
    { label: "updated", value: counts.updated, tone: "text-text" },
    { label: "skipped", value: counts.skipped, tone: "text-muted" },
    { label: "failed", value: counts.failed, tone: "text-danger" },
  ];
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-meta">
      {parts
        .filter((p) => p.value > 0 || p.label === "imported")
        .map((p) => (
          <span key={p.label} className={p.tone}>
            {p.value} {p.label}
          </span>
        ))}
      <span className="text-muted">of {counts.found} found</span>
    </span>
  );
}
