import { ApiError, humanMessage } from "@/lib/errors";

/**
 * Something failed, said in a sentence, with a way forward.
 *
 * Two rules, both learned from the alternative:
 *
 * A retry is offered only when retrying could work. A 4xx will fail
 * identically next time, and a button that reproduces the same error teaches
 * people the product is unreliable rather than that they lack access.
 *
 * The status code is never the message. "403" is not a sentence; "You don't
 * have access to this. An administrator can grant it." tells somebody what to
 * do next. The code stays available to whoever is debugging, in `title`.
 */
export function ErrorState({
  error,
  onRetry,
  className = "",
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const retryable = !(error instanceof ApiError) || error.isRetryable;
  const status = error instanceof ApiError ? error.status : undefined;

  return (
    <div
      role="alert"
      className={`card flex flex-col items-start gap-3 p-md ${className}`}
      title={status ? `HTTP ${status}` : undefined}
    >
      <p className="text-ui text-text">{humanMessage(error)}</p>
      {onRetry && retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[40px] rounded-md bg-action px-3 text-ui font-medium text-action-text hover:opacity-90"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
