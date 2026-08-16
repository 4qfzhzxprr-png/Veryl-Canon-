import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ErrorState } from "./ErrorState";
import { Skeleton } from "./Skeleton";

/**
 * Every asynchronous screen, in one place.
 *
 * The alternative — each screen writing its own `if (isPending) … if (isError)
 * …` — is how a product ends up with four loading treatments, two error
 * dialects, and three screens that forgot the empty case entirely. It is also
 * how the empty case gets confused with the loading case, which is the bug
 * users read as "it's broken".
 *
 * Deliberately takes the whole query result rather than loose props: it is then
 * impossible to render data while `isPending`, or to forget to pass `refetch`
 * to the retry. The type parameter flows through, so `children` receives
 * narrowed, non-nullable data.
 *
 * `isEmpty` is a predicate rather than a boolean so the caller cannot compute
 * it from stale data during a refetch.
 */
export function Async<T>({
  query,
  children,
  loadingLabel,
  skeleton,
  empty,
  isEmpty,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  loadingLabel: string;
  /** Shaped like the settled content. Defaults to a generic block. */
  skeleton?: ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
}) {
  if (query.isPending) {
    // The label is announced whether or not the caller supplied a visual. It
    // used to ride along on the DEFAULT skeleton only, so any screen that
    // passed its own shape — which is every screen worth shaping — made the
    // wait silent for a screen reader while looking finished to everyone else.
    return (
      <div role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">{loadingLabel}</span>
        {skeleton ?? <Skeleton variant="block" label={loadingLabel} />}
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (empty && isEmpty?.(query.data)) {
    return <>{empty}</>;
  }
  return <>{children(query.data)}</>;
}
