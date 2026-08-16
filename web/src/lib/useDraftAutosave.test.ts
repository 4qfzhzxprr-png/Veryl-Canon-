import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveStateLabel, useDraftAutosave } from "./useDraftAutosave";
import { ApiError } from "./errors";

/**
 * The editor is where unsaved work gets lost, so every test here is about one
 * of the two ways this can fail somebody: losing what they typed, or telling
 * them it is safe when it is not.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const ok = (at = "2026-08-16T20:00:00.000Z") => vi.fn().mockResolvedValue({ updatedAt: at });

/** Advance past the quiet period and let the promise settle. */
async function quiet(ms = 2_100) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useDraftAutosave", () => {
  it("saves once after a pause, not once per keystroke", async () => {
    // A save per keystroke is a write amplifier against a single-writer SQLite
    // record — the one thing this product cannot afford to hammer.
    const save = ok();
    const { result } = renderHook(() => useDraftAutosave({ save }));

    act(() => {
      result.current.changed("a");
      result.current.changed("ab");
      result.current.changed("abc");
    });
    expect(save).not.toHaveBeenCalled();

    await quiet();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abc");
  });

  it("says it is not saved the moment something changes", async () => {
    const { result } = renderHook(() => useDraftAutosave({ save: ok() }));
    act(() => result.current.changed("typed"));
    expect(result.current.state.kind).toBe("dirty");
    expect(result.current.unsaved).toBe(true);
  });

  it("only claims a save that actually happened", async () => {
    const save = ok("2026-08-16T20:30:00.000Z");
    const { result } = renderHook(() => useDraftAutosave({ save }));
    act(() => result.current.changed("v1"));
    await quiet();
    expect(result.current.state).toEqual({ kind: "clean", at: "2026-08-16T20:30:00.000Z" });
    expect(result.current.unsaved).toBe(false);
  });

  it("NEVER reports clean after a failed save", async () => {
    // The failure this exists for: a status line reading "Saved 14:02" over
    // work the server threw away is worse than no status line at all.
    const save = vi.fn().mockRejectedValue(new ApiError(423, "This page is being edited by Ada"));
    const { result } = renderHook(() => useDraftAutosave({ save }));

    act(() => result.current.changed("v1"));
    await quiet();

    expect(result.current.state.kind).toBe("failed");
    expect(saveStateLabel(result.current.state)).toContain("NOT saved");
    expect(saveStateLabel(result.current.state)).toContain("being edited by Ada");
    expect(result.current.unsaved).toBe(true);
  });

  it("keeps the work after a failure, so the next attempt carries it", async () => {
    // Dropping it here is losing it entirely — there is no other copy.
    const save = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "down"))
      .mockResolvedValue({ updatedAt: "t" });
    const { result } = renderHook(() => useDraftAutosave({ save }));

    act(() => result.current.changed("the whole afternoon"));
    await quiet();
    expect(result.current.state.kind).toBe("failed");

    await act(async () => {
      await result.current.saveNow();
    });
    expect(save).toHaveBeenLastCalledWith("the whole afternoon");
    expect(result.current.state.kind).toBe("clean");
  });

  it("does not vouch for keystrokes that arrived while a save was in flight", async () => {
    let release: ((value: { updatedAt: string }) => void) | undefined;
    const save = vi.fn().mockImplementation(
      () => new Promise<{ updatedAt: string }>((resolve) => { release = resolve; }),
    );
    const { result } = renderHook(() => useDraftAutosave({ save }));

    act(() => result.current.changed("first"));
    await quiet();
    expect(result.current.state.kind).toBe("saving");

    // Typed while the request was open. Reporting clean when it returns would
    // claim the server has this too.
    act(() => result.current.changed("second"));
    await act(async () => {
      release?.({ updatedAt: "t" });
    });

    expect(result.current.state.kind).toBe("dirty");
    expect(result.current.unsaved).toBe(true);
  });

  it("does not send two saves at once", async () => {
    let release: (() => void) | undefined;
    const save = vi.fn().mockImplementation(
      () => new Promise<{ updatedAt: string }>((resolve) => {
        release = () => resolve({ updatedAt: "t" });
      }),
    );
    const { result } = renderHook(() => useDraftAutosave({ save }));

    act(() => result.current.changed("a"));
    await quiet();
    act(() => result.current.changed("b"));
    await quiet();

    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => release?.());
  });

  it("saves nothing when there is nothing to save", async () => {
    const save = ok();
    const { result } = renderHook(() => useDraftAutosave({ save }));
    await act(async () => {
      await result.current.saveNow();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("makes one last attempt on the way out", async () => {
    // The difference between losing the last two seconds of typing and losing
    // it silently.
    const save = ok();
    const { result, unmount } = renderHook(() => useDraftAutosave({ save }));
    act(() => result.current.changed("last words"));
    unmount();
    await act(async () => {});
    expect(save).toHaveBeenCalledWith("last words");
  });

  it("warns before the tab closes, and stops warning once it is saved", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { result } = renderHook(() => useDraftAutosave({ save: ok() }));

    act(() => result.current.changed("unsaved"));
    expect(add).toHaveBeenCalledWith("beforeunload", expect.any(Function));

    await quiet();
    expect(result.current.state.kind).toBe("clean");
    // The prompt is removed once there is nothing to lose. A guard that never
    // lifts trains people to click through it.
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("does nothing at all when disabled", async () => {
    const save = ok();
    const { result } = renderHook(() => useDraftAutosave({ save, enabled: false }));
    act(() => result.current.changed("x"));
    await quiet();
    expect(save).not.toHaveBeenCalled();
    expect(result.current.unsaved).toBe(false);
  });
});
