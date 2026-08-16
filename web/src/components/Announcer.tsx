import { useAnnouncement } from "@/lib/announce";

/**
 * The application's single live region, mounted once in the shell.
 *
 * `aria-live="polite"` rather than an alert: the reader is told once the thing
 * they did has settled, without their current sentence being cut off.
 *
 * Two details that are the difference between this working and quietly doing
 * nothing:
 *
 *   * it is ALWAYS in the DOM. A live region added at the same moment as its
 *     text is not announced by most screen readers, which is the usual reason
 *     these appear to be wired up and are not;
 *   * it is OUTSIDE the routes. The bug this replaces put the region inside the
 *     row that had just been approved — the write succeeded, the list refetched,
 *     the row unmounted, and the announcement went with it. Nothing was read
 *     out, and the row simply vanished.
 */
export function Announcer() {
  const message = useAnnouncement();
  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </p>
  );
}
