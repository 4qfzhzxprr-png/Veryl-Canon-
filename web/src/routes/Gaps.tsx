import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { EmptyState } from "@/components/EmptyState";
import { SelectField } from "@/components/Field";
import { Skeleton } from "@/components/Skeleton";
import { api } from "@/lib/api";
import { formatAgo, plural } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { Gap } from "@/types/api";

/**
 * Questions the record could not answer.
 *
 * A gap is evidence, not a task somebody filed: it is created when somebody
 * asked and Canon had nothing to say. The count of times asked is the whole
 * point — it is the difference between a question one person had once and a
 * hole the organisation keeps falling into.
 */
export function Gaps() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "open";
  const query = useQuery({
    queryKey: keys.gaps(status),
    queryFn: () => api.gaps(status === "all" ? undefined : status),
  });

  return (
    <div className="mx-auto max-w-[900px] px-md py-lg sm:px-lg">
      <h1 className="mb-1 font-sans text-title font-bold">Gaps</h1>
      <p className="mb-lg text-ui text-muted">
        Questions people asked that the record could not answer. Each one is a page nobody
        has written yet.
      </p>

      <div className="mb-md max-w-[220px]">
        <SelectField
          label="Show"
          value={status}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            next.set("status", event.currentTarget.value);
            setParams(next, { replace: true });
          }}
        >
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">Everything</option>
        </SelectField>
      </div>

      <Async
        query={query}
        loadingLabel="Loading the gaps in the record"
        skeleton={
          <div className="flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="card" label="Loading a gap" />
            ))}
          </div>
        }
        isEmpty={(view) => view.gaps.length === 0}
        empty={
          <EmptyState
            title={status === "open" ? "No open gaps" : "Nothing here"}
            body={
              status === "open"
                ? "Every question people have asked, the record has been able to answer. New gaps appear here on their own when somebody asks something Canon cannot answer."
                : "No gap in the record has this status."
            }
          />
        }
      >
        {(view) => (
          <>
            <p className="mb-3 text-meta text-muted">
              {plural(view.gaps.length, "gap")} across{" "}
              {plural(view.collections.length, "collection")} you steward.
            </p>
            <ul className="flex flex-col gap-2">
              {view.gaps.map((gap) => (
                <li key={gap.id}>
                  <GapCard gap={gap} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Async>
    </div>
  );
}

function GapCard({ gap }: { gap: Gap }) {
  return (
    <article className="card flex flex-col gap-2 p-md">
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="min-w-0 flex-1 text-ui font-medium text-text">{gap.question}</h2>
        <span className="shrink-0 rounded-sm bg-surface-2 px-2 py-0.5 text-meta text-muted">
          {plural(gap.timesAsked, "time")} asked
        </span>
      </div>

      <p className="text-meta text-muted">
        First asked {formatAgo(gap.firstAskedAt) ?? "—"}, most recently{" "}
        {formatAgo(gap.lastAskedAt) ?? "—"}.
      </p>

      {/* ABSENT and false are different facts. `nowAnswers` is a dry-run probe
          run with the reader's own permissions, and it does not always run —
          on a closed gap, past the probing cap, or where the probe failed. A
          card that said "still unanswered" in all three cases would be
          asserting something the record does not know. */}
      {gap.nowAnswers === true ? (
        <p className="text-meta text-ok">
          The record would answer this now — somebody has written the missing page.
        </p>
      ) : gap.nowAnswers === false ? (
        <p className="text-meta text-warn">The record still cannot answer this.</p>
      ) : null}

      {gap.nearest.length ? (
        <div>
          <h3 className="text-meta font-medium text-muted">Closest pages</h3>
          <ul className="mt-1 flex flex-wrap gap-2">
            {gap.nearest.map((near) => (
              <li key={near.pageId}>
                <a
                  className="rounded-sm border border-border px-2 py-1 text-meta text-action hover:bg-surface-2"
                  href={`#/pages/${near.pageId}`}
                >
                  {near.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {gap.resolution ? (
        <p className="text-meta text-muted">Closed: {gap.resolution}</p>
      ) : null}
    </article>
  );
}
