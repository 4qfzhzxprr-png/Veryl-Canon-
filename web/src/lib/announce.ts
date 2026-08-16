import { useSyncExternalStore } from "react";

/**
 * One live region for the whole application, outside every route.
 *
 * **This exists because of a bug a browser found and jsdom could not.** The
 * announcement used to be rendered inside the component that made the change —
 * a queue row saying "approved". The moment the write succeeded, the queue
 * refetched, the row left the list, and the announcement was unmounted with it.
 * A screen-reader user got silence: the row they were on vanished and nothing
 * said why. The test passed because it held the request pending, so the row
 * never unmounted.
 *
 * The lesson generalises: **an announcement must outlive whatever caused it.**
 * So it lives here, subscribed to by one region in the shell, and every
 * mutation publishes to it (see `useCanonMutation`).
 */
let message = "";
const listeners = new Set<() => void>();

export function announce(next: string): void {
  // The same sentence twice in a row is a real case — approving two pages with
  // the same title — and an unchanged string is not re-announced by screen
  // readers. A trailing space nobody sees makes it a different string.
  message = next && next === message ? `${next} ` : next;
  for (const listener of listeners) listener();
}

export function clearAnnouncement(): void {
  message = "";
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnnouncement(): string {
  return useSyncExternalStore(subscribe, () => message, () => "");
}
