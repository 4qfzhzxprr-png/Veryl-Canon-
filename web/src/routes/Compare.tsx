import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { ErrorState } from "@/components/ErrorState";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { diffLines, toHunks, type DiffLine } from "@/lib/diff";
import { formatDateTime, plural } from "@/lib/format";
import { keys } from "@/lib/queryKeys";

/**
 * Two versions of a page, side by side.
 *
 * The screen somebody opens to answer "what changed between March and now", and
 * they act on the answer — so the diff is a real longest-common-subsequence one
 * (`lib/diff.ts`) rather than a line-by-line walk, and it is tested harder than
 * anything else in this client.
 *
 * Both versions are fetched in parallel. Sequentially, comparing an old version
 * takes twice as long for no reason, and neither request depends on the other.
 */
export function Compare() {
  const { id = "", a = "", b = "" } = useParams();
  const older = Math.min(Number(a), Number(b));
  const newer = Math.max(Number(a), Number(b));

  const [left, right] = useQueries({
    queries: [older, newer].map((n) => ({
      queryKey: keys.pages.version(id, n),
      queryFn: () => api.version(id, n),
      enabled: Number.isFinite(n),
    })),
  });

  const result = useMemo(() => {
    if (!left?.data || !right?.data) return null;
    return diffLines(left.data.body, right.data.body);
  }, [left?.data, right?.data]);

  const hunks = useMemo(() => (result ? toHunks(result.lines) : []), [result]);

  return (
    <div className="mx-auto max-w-[1000px] px-md py-lg sm:px-lg">
      <p className="mb-2 text-meta">
        <a className="text-action hover:underline" href={`#/pages/${id}/history`}>
          ← All versions
        </a>
      </p>
      <h1 className="mb-1 font-sans text-title font-bold">
        Version {older} compared with version {newer}
      </h1>

      {left?.isError || right?.isError ? (
        <ErrorState
          error={left?.error ?? right?.error}
          onRetry={() => {
            void left?.refetch();
            void right?.refetch();
          }}
        />
      ) : !left?.data || !right?.data ? (
        <div role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Comparing the two versions</span>
          <Skeleton variant="block" label="Comparing the two versions" />
        </div>
      ) : (
        <>
          <p className="mb-lg text-ui text-muted">
            Version {older} was published {formatDateTime(left.data.createdAt)}; version{" "}
            {newer}, {formatDateTime(right.data.createdAt)}.
          </p>

          {result?.tooLarge ? (
            // Said, not hidden. A silently degraded diff on a screen somebody
            // is about to act on is worse than no diff.
            <p role="alert" className="rounded-md bg-warn/10 px-3 py-2 text-ui text-warn">
              These versions are too long to compare here. Open each one and read
              them side by side.
            </p>
          ) : hunks.length === 0 ? (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-ui text-muted">
              The text of these two versions is identical. Something else about the
              page changed — its fields, or its standing.
            </p>
          ) : (
            <>
              <p className="mb-2 text-meta text-muted" role="status">
                {plural(result?.added ?? 0, "line")} added,{" "}
                {plural(result?.removed ?? 0, "line")} removed.
              </p>
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse font-mono text-meta">
                  <caption className="sr-only">
                    Line-by-line comparison. Each row is marked added, removed or
                    unchanged.
                  </caption>
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">Line in version {older}</th>
                      <th scope="col">Line in version {newer}</th>
                      <th scope="col">Change</th>
                      <th scope="col">Text</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hunks.map((hunk, index) => (
                      <Hunk key={index} lines={hunk.lines} skipped={hunk.skipped} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Hunk({ lines, skipped }: { lines: DiffLine[]; skipped: number }) {
  return (
    <>
      {skipped > 0 ? (
        <tr className="bg-surface-2">
          <td colSpan={4} className="px-3 py-1 text-center text-muted">
            {plural(skipped, "unchanged line")} not shown
          </td>
        </tr>
      ) : null}
      {lines.map((line, index) => (
        <Row key={`${line.before}-${line.after}-${index}`} line={line} />
      ))}
    </>
  );
}

const TONE: Record<DiffLine["op"], string> = {
  added: "bg-ok/10",
  removed: "bg-danger/10",
  same: "",
};

/**
 * Colour is never the message.
 *
 * Each row carries a `+` or `-` and a screen-reader-only word, so a reader who
 * cannot distinguish the two tints — one man in twelve — is reading the same
 * comparison as everybody else rather than a page of undifferentiated text.
 */
function Row({ line }: { line: DiffLine }) {
  const marker = line.op === "added" ? "+" : line.op === "removed" ? "−" : " ";
  return (
    <tr className={TONE[line.op]}>
      <td className="w-12 select-none px-2 py-0.5 text-right align-top text-muted">
        {line.before ?? ""}
      </td>
      <td className="w-12 select-none px-2 py-0.5 text-right align-top text-muted">
        {line.after ?? ""}
      </td>
      <td className="w-6 select-none px-1 py-0.5 align-top text-muted" aria-hidden>
        {marker}
      </td>
      <td className="whitespace-pre-wrap break-words px-2 py-0.5 align-top text-text">
        {line.op !== "same" ? (
          <span className="sr-only">{line.op === "added" ? "Added: " : "Removed: "}</span>
        ) : null}
        {line.text === "" ? " " : line.text}
      </td>
    </tr>
  );
}
