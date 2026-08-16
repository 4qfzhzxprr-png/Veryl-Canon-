import type { Actor } from "@/types/api";

/**
 * Who the development picker last chose.
 *
 * `canon.actor`, the SAME key the original client uses, deliberately: while
 * both clients are reachable a reader crosses between them mid-task, and two
 * keys would mean signing in twice to move between two halves of the same
 * application.
 *
 * This is only ever a dev-door convenience. A real deployment identifies people
 * by session cookie and this is never read — which is why nothing here is
 * treated as trustworthy: the server verifies the header or refuses, and a
 * tampered value in local storage buys nothing that typing a different header
 * would not.
 */
const KEY = "canon.actor";

export function rememberedActor(): Actor | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o["id"] !== "string" || typeof o["name"] !== "string") return null;
    return { id: o["id"], name: o["name"], kind: o["kind"] === "agent" ? "agent" : "person" };
  } catch {
    // Storage can be unavailable outright — Safari in private browsing throws
    // on read. Not being able to remember somebody is not a reason to fail to
    // render the app.
    return null;
  }
}

export function rememberActor(actor: Actor | null): void {
  try {
    if (actor) localStorage.setItem(KEY, JSON.stringify(actor));
    else localStorage.removeItem(KEY);
  } catch {
    /* see above */
  }
}
