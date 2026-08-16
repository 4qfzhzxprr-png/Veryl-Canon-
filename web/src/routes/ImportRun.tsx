import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { SelectField } from "@/components/Field";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { formatDateTime, plural, TYPE_LABELS } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { ImportFileResult, ImportOutcome, ImportRunDetail } from "@/types/api";

const OUTCOME_TONE: Record<ImportOutcome, string> = {
  imported: "bg-ok/12 text-ok border-ok/30",
  updated: "bg-action/10 text-action border-action/30",
  skipped: "bg-surface-2 text-muted border-border",
  failed: "bg-danger/12 text-danger border-danger/30",
};

/**
 * One import run: every file it read, and what became of each.
 *
 * The screen exists for the failures. A run that says "48 imported" and hides
 * the two that did not land is worse than one that ran badly and said so —
 * somebody believes the corpus is complete, and the two missing pages are
 * discovered by whoever needed them.
 */
export function ImportRun() {
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: keys.imports.one(id),
    queryFn: () => api.importRun(id),
  });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href="#/imports">
          ← All imports
        </a>
      </p>

      <Async
        query={query}
        loadingLabel="Loading this import run"
        skeleton={
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton variant="row" label="Loading the run" />
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} variant="line" label="Loading a file" />
            ))}
          </div>
        }
      >
        {(run) => <Detail run={run} />}
      </Async>
    </div>
  );
}

function Detail({ run }: { run: ImportRunDetail }) {
  // Failures first by default. They are the only rows on this screen anybody
  // has to act on, and on a run of four hundred files they are otherwise
  // several screens down.
  const [filter, setFilter] = useState<ImportOutcome | "all">(
    run.counts.failed > 0 ? "failed" : "all",
  );
  const files = filter === "all" ? run.files : run.files.filter((f) => f.outcome === filter);

  return (
    <>
      <h1 className="font-sans text-title font-bold">Import run</h1>
      <p className="mt-1 text-ui text-muted">
        {TYPE_LABELS[run.type] ?? run.type} pages, {run.hierarchy === "flat"
          ? "with no page tree recovered"
          : `page tree recovered from the ${run.hierarchy === "tree" ? "export index" : "page breadcrumbs"}`}
        .
      </p>

      <dl className="mt-md grid grid-cols-2 gap-x-4 gap-y-2 text-meta sm:grid-cols-4">
        <Fact term="Started" value={formatDateTime(run.startedAt)} />
        <Fact term="Finished" value={formatDateTime(run.finishedAt)} />
        <Fact term="Source" value={run.source} />
        <Fact term="Read from" value={run.path} />
      </dl>

      {/* Decided ONCE for the whole corpus, and recorded on the run rather than
          only on the pages — so a reader of this record can see what was
          decided, and a re-run repeats the same answer. */}
      <section className="mt-lg">
        <h2 className="text-ui font-semibold">What every page got</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-meta sm:grid-cols-3">
          <Fact term="Owner" value={run.fields.ownerId ?? "the person who ran it"} />
          <Fact term="Approver" value={run.fields.approverId ?? "none named"} />
          <Fact term="Review date" value={run.fields.reviewDate ?? "none set"} />
        </dl>
        <p className="mt-2 text-meta text-muted">
          Everything this run landed arrived as a draft. Nothing an import lands carries the
          Canonical mark, whoever ran it.
        </p>
      </section>

      <section className="mt-lg">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-ui font-semibold">
            Files — {plural(run.counts.found, "found")}
          </h2>
          <div className="min-w-[200px]">
            <SelectField
              label="Show"
              value={filter}
              onChange={(event) =>
                setFilter(event.currentTarget.value as ImportOutcome | "all")
              }
            >
              <option value="all">Every file ({run.counts.found})</option>
              <option value="failed">Failed ({run.counts.failed})</option>
              <option value="imported">Imported ({run.counts.imported})</option>
              <option value="updated">Updated ({run.counts.updated})</option>
              <option value="skipped">Skipped ({run.counts.skipped})</option>
            </SelectField>
          </div>
        </div>

        {files.length === 0 ? (
          <p className="mt-3 text-ui text-muted">No file in this run has that outcome.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {files.map((file) => (
              <li key={file.file}>
                <FileRow file={file} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {run.counts.failed > 0 ? (
        <p className="mt-lg rounded-md bg-surface-2 px-3 py-2 text-ui text-muted">
          Running this import again skips the files that have not changed and retries the
          ones that did not land.
        </p>
      ) : null}
    </>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{term}</dt>
      <dd className="break-words text-text">{value}</dd>
    </div>
  );
}

function FileRow({ file }: { file: ImportFileResult }) {
  return (
    <div className="card flex flex-col gap-1 p-3">
      <div className="flex flex-wrap items-start gap-2">
        {/* The path, wrapped rather than truncated: two files in a Confluence
            export commonly differ only in the last segment. */}
        <code className="min-w-0 flex-1 break-all text-meta text-muted">{file.file}</code>
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-meta font-medium ${OUTCOME_TONE[file.outcome]}`}
        >
          {file.outcome}
        </span>
      </div>

      {file.pageId ? (
        <a className="text-ui text-action hover:underline" href={`#/pages/${file.pageId}`}>
          {file.title ?? "the page it landed"}
        </a>
      ) : file.title ? (
        <span className="text-ui text-text">{file.title}</span>
      ) : null}

      {/* The importer's own words. This is the whole reason the screen exists,
          so it is never abbreviated and never hidden behind a disclosure. */}
      {file.reason ? <p className="text-meta text-muted">{file.reason}</p> : null}
    </div>
  );
}
