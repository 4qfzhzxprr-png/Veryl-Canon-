import { useCallback, useEffect, useRef, useState } from "react";
import { humanMessage } from "./errors";

export type SaveState =
  | { kind: "clean"; at: string | null }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "failed"; why: string };

/**
 * Autosave for the editor, and the guard that stops somebody walking away from
 * unsaved work.
 *
 * **This is a deliberate change from the original client, not a port of it.**
 * The original saved once — on the first change, to claim the page lock — and
 * then only when the author pressed Save. Everything typed in between lived in
 * a textarea and nowhere else. Close the tab, follow a link, let the laptop
 * sleep and lose the session: an afternoon of policy writing, gone, with
 * nothing to recover from. There was no `beforeunload` either.
 *
 * Three rules make the change safe rather than merely convenient:
 *
 *   * **the lock still comes from the first real change.** Opening the editor
 *     writes nothing and locks nothing — that is the server's contract, and
 *     walking in the door used to take the lock and put an untyped draft in
 *     everybody's queue. Autosave changes when subsequent saves happen, not
 *     what the first one means.
 *   * **a failed save is never described as a success.** The state machine has
 *     no path from `failed` to `clean` that does not go through a save that
 *     actually returned. A status line reading "Saved 14:02" over work the
 *     server threw away is worse than no status line.
 *   * **it saves on a pause, not on a keystroke.** One request per two seconds
 *     of quiet, and one final save on unmount, so a draft is not a write
 *     amplifier against a single-writer SQLite record.
 */
const QUIET_MS = 2_000;

export interface Autosave<T> {
  state: SaveState;
  /** Call whenever the form changes. */
  changed: (value: T) => void;
  /** Save right now — the explicit Save button, and before publishing. */
  saveNow: () => Promise<void>;
  /** True while there is work the server has not acknowledged. */
  unsaved: boolean;
}

export function useDraftAutosave<T>({
  save,
  enabled = true,
}: {
  save: (value: T) => Promise<{ updatedAt: string }>;
  enabled?: boolean;
}): Autosave<T> {
  const [state, setState] = useState<SaveState>({ kind: "clean", at: null });
  const pending = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const latestSave = useRef(save);
  latestSave.current = save;

  const flush = useCallback(async () => {
    if (pending.current === null || inFlight.current) return;
    const value = pending.current;
    // Cleared BEFORE the request, so a change made while it is in flight is
    // seen as new work rather than being swallowed by this save's success.
    pending.current = null;
    inFlight.current = true;
    setState({ kind: "saving" });
    try {
      const result = await latestSave.current(value);
      // Only if something arrived after us do we stay dirty. Reporting clean
      // here would vouch for the newer keystrokes too.
      setState(
        pending.current === null ? { kind: "clean", at: result.updatedAt } : { kind: "dirty" },
      );
    } catch (error) {
      // The work stays pending, so the next attempt carries it. It is NOT put
      // back only on success — losing it here is losing it entirely.
      pending.current = value;
      setState({ kind: "failed", why: humanMessage(error) });
    } finally {
      inFlight.current = false;
    }
  }, []);

  const changed = useCallback(
    (value: T) => {
      if (!enabled) return;
      pending.current = value;
      setState((current) => (current.kind === "saving" ? current : { kind: "dirty" }));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), QUIET_MS);
    },
    [enabled, flush],
  );

  const saveNow = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    await flush();
  }, [flush]);

  const unsaved = state.kind === "dirty" || state.kind === "failed" || state.kind === "saving";

  // Closing the tab, reloading, following a link out. The browser shows its own
  // wording — a custom message has been ignored for a decade — so what matters
  // is only that the prompt happens at all.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Still set for older browsers, which require a truthy returnValue.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // One last attempt on the way out. It cannot be awaited — the component is
  // already going — but it is the difference between losing the last two
  // seconds of typing and losing it silently.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  return { state, changed, saveNow, unsaved };
}

/** What the status line says. Never claims a save that did not happen. */
export function saveStateLabel(state: SaveState): string {
  switch (state.kind) {
    case "saving":
      return "Saving…";
    case "dirty":
      return "Not saved yet";
    case "failed":
      return `NOT saved — ${state.why}`;
    case "clean":
      return state.at ? "Draft saved" : "No changes yet";
  }
}
