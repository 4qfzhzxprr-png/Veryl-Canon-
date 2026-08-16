import {
  useMutation,
  useQueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { humanMessage } from "./errors";

/**
 * Every write in this client goes through here.
 *
 * Four things have to happen on every mutation, and each of them is one somebody
 * will forget if it is left to the call site:
 *
 *   * **the control is disabled while it is in flight** — a review button that
 *     accepts a second click sends a second approval, and the record does not
 *     have a way to un-approve something;
 *   * **the failure is said in words**, through `humanMessage`, so a refusal
 *     the server explained does not surface as a silent no-op;
 *   * **the outcome is announced**, because a row that quietly disappears from
 *     a list tells a sighted reader everything and a screen-reader user
 *     nothing;
 *   * **the affected queries are invalidated by key**, not by refetching the
 *     world.
 *
 * **No optimistic updates, deliberately.** Every mutation in Canon changes the
 * record, and a change that appears to have succeeded and did not is a lie
 * about the record — which is the one thing this product cannot be wrong about.
 * The row moves when the server says it moved.
 */
export interface CanonMutationOptions<TArgs, TResult> {
  run: (args: TArgs) => Promise<TResult>;
  /** Query keys to invalidate once the server has confirmed it. Prefixes work:
   *  `["collections"]` covers the listing and every collection under it. */
  invalidates?: QueryKey[];
  /** Said out loud on success. Given the result so it can name what changed. */
  announce?: (result: TResult, args: TArgs) => string;
  onDone?: (result: TResult, args: TArgs) => void;
}

export interface CanonMutation<TArgs, TResult> {
  submit: (args: TArgs) => void;
  /** True while the server has not answered. Put it on the control's
   *  `disabled`, not on a spinner somewhere else on the page. */
  busy: boolean;
  /** The refusal, already turned into a sentence. Null when there is none. */
  error: string | null;
  /** What to say. Render inside a live region — see `LiveRegion`. */
  message: string | null;
  reset: () => void;
  raw: UseMutationResult<TResult, unknown, TArgs>;
}

export function useCanonMutation<TArgs, TResult>(
  options: CanonMutationOptions<TArgs, TResult>,
): CanonMutation<TArgs, TResult> {
  const client = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  // Held in a ref so changing the callback between renders — which every inline
  // arrow does — cannot make the mutation run a stale version of it.
  const latest = useRef(options);
  latest.current = options;

  const raw = useMutation<TResult, unknown, TArgs>({
    mutationFn: (args) => latest.current.run(args),
    // No retry on a write. A failed write may have partially applied, and
    // repeating it is how one approval becomes two.
    retry: false,
    onSuccess: (result, args) => {
      const { invalidates, announce, onDone } = latest.current;
      for (const key of invalidates ?? []) void client.invalidateQueries({ queryKey: key });
      setMessage(announce ? announce(result, args) : null);
      onDone?.(result, args);
    },
    onError: () => setMessage(null),
  });

  const submit = useCallback(
    (args: TArgs) => {
      // Guarded here rather than only in the UI: a keyboard repeat, a double
      // tap and a slow network all produce a second call that the disabled
      // attribute alone does not stop.
      if (raw.isPending) return;
      setMessage(null);
      raw.mutate(args);
    },
    [raw],
  );

  return {
    submit,
    busy: raw.isPending,
    error: raw.isError ? humanMessage(raw.error) : null,
    message,
    reset: () => {
      setMessage(null);
      raw.reset();
    },
    raw,
  };
}
