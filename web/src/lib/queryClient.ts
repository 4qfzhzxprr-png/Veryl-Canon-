import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./errors";

/**
 * Server state lives here, not in a store.
 *
 * The distinction that matters: almost nothing in Canon is client state. A
 * collection list, a page, a queue — these are *caches of somebody else's
 * data*, and modelling them as application state means hand-writing loading
 * flags, staleness and invalidation for each one. The previous client did
 * exactly that, in a module-level `state` object, and every screen refreshed it
 * differently.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A knowledge base is read far more than it is written, and its content
      // changes on human timescales. Thirty seconds is long enough to make
      // navigation instant and short enough that a colleague's edit shows up
      // while you are still looking.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // Never retry what will fail identically: an authorisation failure
      // retried three times is three times the wait for the same answer.
      retry: (failureCount, error) =>
        error instanceof ApiError ? error.isRetryable && failureCount < 2 : failureCount < 2,
      refetchOnWindowFocus: true,
      // A phone that has been in a pocket has a stale everything; a reconnect
      // is the one moment refetching is unambiguously wanted.
      refetchOnReconnect: true,
    },
    mutations: {
      // Writes are never retried automatically. Canon's record is append-only
      // and audited: a duplicate write is a second entry somebody has to
      // explain, which is worse than an error somebody can act on.
      retry: false,
    },
  },
});
