import { afterEach, describe, expect, it, vi } from "vitest";
import { api, request, setSession } from "./api";
import { ApiError } from "./errors";
import type { Session } from "@/types/api";

/**
 * The seam, tested where it actually broke.
 *
 * The first version of this client was pointed at `/api` and shaped every
 * response by guessing. Every call 404'd and every parser was wrong, and
 * nothing caught it because nothing had ever run against a real server. These
 * tests are the guard: the paths and the shapes here were read off a running
 * Canon, so a change to either fails here rather than in front of somebody.
 */

function respond(body: unknown, init: ResponseInit = {}) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    }),
  );
}

function session(over: Partial<Session> = {}): Session {
  return {
    mode: "dev",
    sso: false,
    devAuth: true,
    authenticated: true,
    viaCookie: false,
    actor: { id: "a1", name: "Ada", kind: "person" },
    orgRole: null,
    csrfToken: null,
    csrfHeader: "x-canon-csrf",
    loginUrl: null,
    ...over,
  };
}

afterEach(() => {
  setSession(null);
  vi.restoreAllMocks();
});

describe("where the client points", () => {
  it("calls the server at the root, not under /api", async () => {
    // THE BUG THIS FILE EXISTS FOR. Canon mounts its routes at the root; a
    // client prefixing them 404s on every single call, and looks to the reader
    // like an empty, broken product.
    const fetchMock = respond([]);
    vi.stubGlobal("fetch", fetchMock);
    await api.collections();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/collections");
  });

  it("percent-encodes an id rather than pasting it into the path", async () => {
    const fetchMock = respond({ id: "x", name: "n", abilities: {} });
    vi.stubGlobal("fetch", fetchMock);
    await api.collection("a/b?c");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/collections/a%2Fb%3Fc");
  });

  it("leaves paging parameters off the audit summary", async () => {
    // The summary counts the whole filtered population. Passing `before` would
    // make it summarise one page and report that as the total, which is a
    // number an auditor would reasonably act on.
    const fetchMock = respond({ matching: 0, actions: [] });
    vi.stubGlobal("fetch", fetchMock);
    await api.auditSummary({ action: "page.read", before: 99, limit: 50 });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("action=page.read");
    expect(url).not.toContain("before");
    expect(url).not.toContain("limit");
  });
});

describe("which identity travels", () => {
  it("sends X-Actor-Id for a header session", async () => {
    setSession(session());
    const fetchMock = respond([]);
    vi.stubGlobal("fetch", fetchMock);
    await api.collections();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Actor-Id")).toBe("a1");
  });

  it("never sends X-Actor-Id beside a cookie, because the server refuses the pair", async () => {
    setSession(session({ viaCookie: true }));
    const fetchMock = respond([]);
    vi.stubGlobal("fetch", fetchMock);
    await api.collections();
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("X-Actor-Id")).toBeNull();
  });

  it("sends the CSRF token on a write and never on a read", async () => {
    setSession(session({ viaCookie: true, csrfToken: "tok" }));
    const fetchMock = respond({ id: "c", name: "n", abilities: {} });
    vi.stubGlobal("fetch", fetchMock);

    await api.createCollection({ name: "n", description: "", restricted: false });
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get("x-canon-csrf")).toBe("tok");

    await api.collections().catch(() => {});
    expect((fetchMock.mock.calls[1]?.[1]?.headers as Headers).get("x-canon-csrf")).toBeNull();
  });
});

describe("what a failure becomes", () => {
  it("carries the server's own sentence rather than the status text", async () => {
    vi.stubGlobal(
      "fetch",
      respond({ error: "forbidden", message: "Requires admin access to this collection." }, { status: 403 }),
    );
    await expect(api.collections()).rejects.toMatchObject({
      status: 403,
      message: "Requires admin access to this collection.",
      reason: "forbidden",
    });
  });

  it("distinguishes never reaching the server from any answer it could give", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(api.collections()).rejects.toMatchObject({ status: 0 });
  });

  it("turns a shape the server did not send into a caught error, not undefined", async () => {
    // The whole argument for narrowing: a server change surfaces HERE, named,
    // rather than as a blank card three components later.
    vi.stubGlobal("fetch", respond([{ name: "no id" }]));
    await expect(api.collections()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("narrowing the shapes that matter", () => {
  it("reads the collection listing as a bare array", async () => {
    vi.stubGlobal(
      "fetch",
      respond([
        {
          id: "c1",
          name: "Benefits",
          description: "What we offer",
          restricted: true,
          createdAt: "2026-08-16T19:43:54.689Z",
          archivedAt: null,
          archivedPages: 3,
          abilities: { collectionId: "c1", role: "admin", createPage: { can: true, why: null } },
        },
      ]),
    );
    const [row] = await api.collections();
    expect(row).toMatchObject({ id: "c1", name: "Benefits", restricted: true, archivedPages: 3 });
    expect(row?.abilities.createPage.can).toBe(true);
  });

  it("defaults a missing ability CLOSED", async () => {
    // Backwards, this offers a control the server will refuse — the exact
    // failure the abilities projection exists to prevent.
    vi.stubGlobal(
      "fetch",
      respond([{ id: "c1", name: "n", abilities: { role: "reader" } }]),
    );
    const [row] = await api.collections();
    expect(row?.abilities.createPage).toEqual({ can: false, why: null });
    expect(row?.abilities.addMember.can).toBe(false);
  });

  it("keeps a gap's unrun probe absent rather than calling it false", async () => {
    // "The probe did not run" and "the record cannot answer this" are different
    // facts; collapsing them makes the screen assert the second.
    vi.stubGlobal(
      "fetch",
      respond({
        scope: "steward",
        collections: [],
        gaps: [
          { id: "g1", question: "q", timesAsked: 2, nearest: [], status: "open" },
          { id: "g2", question: "q2", timesAsked: 1, nearest: [], status: "open", nowAnswers: false },
        ],
      }),
    );
    const view = await api.gaps();
    expect("nowAnswers" in view.gaps[0]!).toBe(false);
    expect(view.gaps[1]?.nowAnswers).toBe(false);
  });

  it("treats an unknown role as no role at all", async () => {
    vi.stubGlobal("fetch", respond([{ id: "c1", name: "n", abilities: { role: "wizard" } }]));
    const [row] = await api.collections();
    expect(row?.abilities.role).toBeNull();
  });
});

describe("request", () => {
  it("sends no body on a read, rather than the string 'undefined'", async () => {
    const fetchMock = respond({});
    vi.stubGlobal("fetch", fetchMock);
    await request("GET", "/health", () => null);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("hands 204 to the parser as undefined rather than trying to read a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(request("DELETE", "/x", (raw) => raw ?? "empty")).resolves.toBe("empty");
  });
});
