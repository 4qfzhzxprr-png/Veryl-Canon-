/** What went wrong, in a shape the UI can act on rather than a string. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's machine-readable reason, when it gave one. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Signed out, or the session expired underneath us. */
  get isAuth(): boolean {
    return this.status === 401;
  }

  /** Reachable, but this caller may not. Distinct from `isAuth` because the
   *  remedies differ: one is "sign in", the other is "ask an administrator",
   *  and offering the wrong one wastes somebody's afternoon. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** Worth offering a retry for. A 4xx will fail identically next time. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

/** A sentence to show a person, never a status code.
 *
 *  Deliberately not the server's raw message for 5xx: those leak internals and
 *  read as accusations. A 4xx message IS shown, because the server is the only
 *  thing that knows why and it writes them for people. */
export function humanMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "We couldn't reach Canon. Check your connection and try again.";
    if (err.isAuth) return "Your session has ended. Sign in to continue.";
    if (err.isForbidden) return "You don't have access to this. An administrator can grant it.";
    if (err.status === 404) return "That isn't here — it may have moved, or been archived.";
    if (err.status === 429) return "That was a lot at once. Give it a moment and try again.";
    if (err.status >= 500) return "Something went wrong on our side. Try again in a moment.";
    return err.message;
  }
  return "Something went wrong. Try again in a moment.";
}
