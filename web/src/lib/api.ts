// The one place the client talks to the server.
//
// Three jobs, and they are here rather than in components so no screen can
// forget one: carry the session correctly, turn a failure into a typed error,
// and narrow the response before anything downstream sees it.
import { ApiError } from "./errors";
import type { Collection, PageSummary, Queue, Session } from "@/types/api";

const BASE = "/api";

/** The session, learned once at start-up and needed by every write.
 *
 *  Module-level rather than React state on purpose: it is read inside the
 *  fetch layer, which has no hooks, and it changes at most twice in a session
 *  (sign in, sign out). A context would mean threading it through every caller
 *  to solve a problem nobody has. */
let session: Session | null = null;

export function setSession(next: Session | null): void {
  session = next;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

function headersFor(method: string, body: unknown): Headers {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");

  // A cookie session is ambient: it identifies the caller on its own, and the
  // server REFUSES a request carrying both it and an X-Actor-Id. So the two are
  // mutually exclusive here rather than merely unusual together.
  if (session && !session.viaCookie && session.actor) {
    headers.set("X-Actor-Id", session.actor.id);
  }
  // CSRF only where it means something: a safe method cannot change anything,
  // and a header-identified request is not ambient so it cannot be forged by a
  // third-party page.
  if (session?.viaCookie && session.csrfToken && !SAFE.has(method)) {
    headers.set(session.csrfHeader, session.csrfToken);
  }
  return headers;
}

/**
 * @param parse narrows the response. Required, not optional: this is what keeps
 * a server change from surfacing as `undefined` three components later. A
 * parser that throws produces a caught error at the call site instead.
 */
export async function request<T>(
  method: string,
  path: string,
  parse: (raw: unknown) => T,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    // Built conditionally rather than passing `body: undefined`, which
    // `exactOptionalPropertyTypes` correctly refuses: an absent body and a
    // body that is the value `undefined` are different things, and only one of
    // them is what a GET means.
    const init: RequestInit = {
      method,
      headers: headersFor(method, body),
      credentials: "same-origin",
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    // Status 0 is "never reached the server" — a different problem from any
    // answer it could have given, and the only one worth an automatic retry.
    throw new ApiError(0, "network");
  }

  if (!res.ok) {
    let message = res.statusText;
    let reason: string | undefined;
    try {
      const payload = (await res.json()) as { message?: string; reason?: string };
      if (typeof payload.message === "string") message = payload.message;
      if (typeof payload.reason === "string") reason = payload.reason;
    } catch {
      /* an error page rather than an error document; the status still stands */
    }
    throw new ApiError(res.status, message, reason);
  }

  if (res.status === 204) return parse(undefined);
  return parse(await res.json());
}

// --------------------------------------------------------------------------- //
// Parsers. Small, boring, and the reason a server change is a caught error.
// --------------------------------------------------------------------------- //
function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new ApiError(500, `expected ${field} to be text`);
  return v;
}

function arr(v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) throw new ApiError(500, `expected ${field} to be a list`);
  return v;
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null) {
    throw new ApiError(500, `expected ${field} to be an object`);
  }
  return v as Record<string, unknown>;
}

const parseSession = (raw: unknown): Session => {
  const o = obj(raw, "session");
  const actor = o["actor"] == null ? null : obj(o["actor"], "actor");
  return {
    actor: actor && {
      id: str(actor["id"], "actor.id"),
      name: str(actor["name"], "actor.name"),
      kind: actor["kind"] === "agent" ? "agent" : "person",
    },
    viaCookie: o["viaCookie"] === true,
    csrfToken: typeof o["csrfToken"] === "string" ? o["csrfToken"] : null,
    csrfHeader: typeof o["csrfHeader"] === "string" ? o["csrfHeader"] : "X-Canon-CSRF",
  };
};

const parseCollections = (raw: unknown): Collection[] =>
  arr(obj(raw, "body")["collections"], "collections").map((row) => {
    const o = obj(row, "collection");
    return {
      id: str(o["id"], "collection.id"),
      name: str(o["name"], "collection.name"),
      description: typeof o["description"] === "string" ? o["description"] : "",
      role: (o["role"] ?? null) as Collection["role"],
      pageCount: typeof o["pageCount"] === "number" ? o["pageCount"] : 0,
      updatedAt: typeof o["updatedAt"] === "string" ? o["updatedAt"] : "",
    };
  });

const parseQueue = (raw: unknown): Queue => {
  const o = obj(raw, "queue");
  const counts = obj(o["counts"] ?? {}, "queue.counts");
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    items: arr(o["items"] ?? [], "queue.items").map((row) => {
      const i = obj(row, "queue.item");
      return {
        id: str(i["id"], "item.id"),
        title: str(i["title"], "item.title"),
        kind: (i["kind"] ?? "review_requested") as Queue["items"][number]["kind"],
        collectionName: typeof i["collectionName"] === "string" ? i["collectionName"] : "",
        waitingSince: typeof i["waitingSince"] === "string" ? i["waitingSince"] : "",
      };
    }),
    counts: {
      total: num(counts["total"]),
      reviewRequested: num(counts["reviewRequested"]),
      changesRequested: num(counts["changesRequested"]),
      divergence: num(counts["divergence"]),
    },
  };
};

const parsePages = (raw: unknown): PageSummary[] =>
  arr(obj(raw, "body")["pages"], "pages").map((row) => {
    const o = obj(row, "page");
    return {
      id: str(o["id"], "page.id"),
      title: str(o["title"], "page.title"),
      state: (o["state"] ?? "draft") as PageSummary["state"],
      collectionId: typeof o["collectionId"] === "string" ? o["collectionId"] : "",
      updatedAt: typeof o["updatedAt"] === "string" ? o["updatedAt"] : "",
      stale: o["stale"] === true,
    };
  });

export const api = {
  session: () => request("GET", "/auth/session", parseSession),
  collections: () => request("GET", "/collections", parseCollections),
  pages: (collectionId: string) =>
    request("GET", `/collections/${encodeURIComponent(collectionId)}/pages`, parsePages),
  queue: () => request("GET", "/queue", parseQueue),
};
