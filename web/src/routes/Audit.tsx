import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Async } from "@/components/Async";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { SelectField } from "@/components/Field";
import { Skeleton } from "@/components/Skeleton";
import { api, type AuditFilter } from "@/lib/api";
import { formatAgo, formatDateTime, plural } from "@/lib/format";
import { keys } from "@/lib/queryKeys";
import type { AuditEvent } from "@/types/api";

const PAGE = 50;

/**
 * The append-only record of what happened.
 *
 * **The filters live in the URL, not in component state.** An auditor who has
 * narrowed the log to one collection and one action has done real work; state
 * that dies on refresh throws it away, and a filtered view that cannot be sent
 * to a colleague is half a tool. It also means Back undoes a filter, which is
 * what Back is for.
 */
export function Audit() {
  const [params, setParams] = useSearchParams();
  const filter: AuditFilter = {
    ...(params.get("collectionId") ? { collectionId: params.get("collectionId")! } : {}),
    ...(params.get("action") ? { action: params.get("action")! } : {}),
    ...(params.get("actorId") ? { actorId: params.get("actorId")! } : {}),
  };
  const before = Number(params.get("before") ?? "") || undefined;

  const events = useQuery({
    queryKey: keys.audit({ ...filter, before }),
    queryFn: () => api.audit({ ...filter, ...(before ? { before } : {}), limit: PAGE }),
  });
  // The population the filter describes, which the table cannot honestly draw
  // without: fifty rows and nothing about the rest asserts a completeness it
  // does not have. Paging parameters are stripped inside `api.auditSummary` —
  // a summary of one page and called the total would be worse than no total.
  const summary = useQuery({
    queryKey: keys.auditSummary(filter),
    queryFn: () => api.auditSummary(filter),
  });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change resets paging: keeping `before` would page through a
    // cursor belonging to a query that no longer exists.
    next.delete("before");
    setParams(next, { replace: true });
  };

  return (
    <div className="mx-auto max-w-[1100px] px-md py-lg sm:px-lg">
      <h1 className="mb-1 font-sans text-title font-bold">Audit log</h1>
      <p className="mb-lg text-ui text-muted">
        Every read, write and decision, in the order it happened. Nothing here can be
        edited or removed.
      </p>

      <div className="mb-md flex flex-wrap items-end gap-3">
        <div className="min-w-[220px]">
          <SelectField
            label="Action"
            value={params.get("action") ?? ""}
            onChange={(event) => setParam("action", event.currentTarget.value)}
            hint={
              summary.data
                ? `${plural(summary.data.matching, "event")} match this filter`
                : "Counting…"
            }
          >
            <option value="">Every action</option>
            {/* The list comes from the RECORD, not from a constant here. A
                hard-coded one was missing ten action types the record actually
                writes while offering four it never does. */}
            {summary.data?.actions.map((a) => (
              <option key={a.action} value={a.action}>
                {a.action} ({a.count})
              </option>
            ))}
          </SelectField>
        </div>
        {Object.keys(filter).length ? (
          <Button onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <Async
        query={events}
        loadingLabel="Loading the audit log"
        skeleton={
          <div className="flex flex-col gap-1.5" aria-hidden>
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} variant="line" label="Loading an event" />
            ))}
          </div>
        }
        isEmpty={(rows) => rows.length === 0}
        empty={
          <EmptyState
            title="Nothing matches"
            body="No event in the record matches this filter. Widen it, or clear it to see everything you may read."
          />
        }
      >
        {(rows) => (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-ui">
                <caption className="sr-only">
                  Audit events, most recent first. {summary.data
                    ? `${plural(summary.data.matching, "event")} match the current filter.`
                    : ""}
                </caption>
                <thead>
                  <tr className="border-b border-border text-left text-meta text-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">When</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Action</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Where</th>
                    <th scope="col" className="py-2 font-medium">Who</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((event) => (
                    <Row key={event.id} event={event} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cursor paging, on the id of the oldest row on screen. Offset
                paging over an append-only log that is still being written
                would repeat rows as new ones arrive above them. */}
            {rows.length === PAGE ? (
              <div className="mt-md flex justify-center">
                <Button
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.set("before", String(rows[rows.length - 1]!.id));
                    setParams(next);
                  }}
                >
                  Older events
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Async>
    </div>
  );
}

function Row({ event }: { event: AuditEvent }) {
  const where = event.pageTitle ?? event.collectionName;
  return (
    <tr className="border-b border-border/60 align-top">
      {/* Relative time for scanning, absolute for the moment the question
          becomes serious — which on an audit log is most of the time. */}
      <td className="whitespace-nowrap py-2.5 pr-3">
        <div className="text-text">{formatAgo(event.at) ?? "—"}</div>
        <div className="text-meta text-muted">{formatDateTime(event.at)}</div>
      </td>
      <td className="py-2.5 pr-3">
        <code className="text-meta text-text">{event.action}</code>
      </td>
      <td className="py-2.5 pr-3">
        {event.pageId ? (
          <a className="text-action hover:underline" href={`#/pages/${event.pageId}`}>
            {where || "a page"}
          </a>
        ) : event.collectionId ? (
          <a className="text-action hover:underline" href={`#/collections/${event.collectionId}`}>
            {where || "a collection"}
          </a>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className="py-2.5">
        <span className="text-text">{event.actorId.slice(0, 8)}</span>
        {event.actorKind === "agent" ? (
          <span className="ml-2 rounded-sm bg-surface-2 px-1.5 py-0.5 text-meta text-muted">
            agent
          </span>
        ) : null}
      </td>
    </tr>
  );
}
