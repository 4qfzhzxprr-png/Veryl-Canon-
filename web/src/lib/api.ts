// The one place the client talks to the server.
//
// Three jobs, and they are here rather than in components so no screen can
// forget one: carry the session correctly, turn a failure into a typed error,
// and narrow the response before anything downstream sees it.
import { ApiError } from "./errors";
import type {
  Ability,
  Actor,
  AuditEvent,
  AuditSummary,
  Collection,
  CollectionAbilities,
  Gap,
  GapsView,
  ImportRun,
  ImportRunDetail,
  Notice,
  Comment,
  Draft,
  Member,
  PageDetail,
  PageNode,
  PageVersion,
  QueuedPage,
  SearchHit,
  Session,
  Source,
  WorkQueue,
} from "@/types/api";

/**
 * The server mounts its routes at the ROOT — `/collections`, not
 * `/api/collections`. This was `/api` in the first draft of this client and
 * every single call 404'd; nothing caught it because nothing had been run
 * against a real server. If this ever needs a prefix again, prove it with curl
 * before changing it.
 */
const BASE = "";

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
      // Canon's failures are `{ error, message }` — `error` is the machine-
      // readable class ('invalid', 'forbidden', 'not_found'), `message` the
      // sentence written for a person. Both are worth keeping.
      const payload = (await res.json()) as { message?: string; error?: string };
      if (typeof payload.message === "string") message = payload.message;
      if (typeof payload.error === "string") reason = payload.error;
    } catch {
      /* an error page rather than an error document; the status still stands */
    }
    throw new ApiError(res.status, message, reason);
  }

  if (res.status === 204) return parse(undefined);
  return parse(await res.json());
}

// --------------------------------------------------------------------------- //
// Narrowing helpers. Small, boring, and the reason a server change is a caught
// error rather than a blank screen.
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

/** Text, or null — the server's own "there is nothing here". */
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const maybeNum = (v: unknown): number | null => (typeof v === "number" ? v : null);

/**
 * An ability, defaulting CLOSED.
 *
 * A malformed or missing ability must never read as permission. The cost of
 * getting this backwards is a control offered to somebody the server will
 * refuse, which is the exact failure the abilities projection exists to
 * prevent.
 */
function ability(v: unknown): Ability {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  return { can: o["can"] === true, why: text(o["why"]) };
}

function role(v: unknown): CollectionAbilities["role"] {
  return v === "view" || v === "comment" || v === "edit" || v === "approve" || v === "admin"
    ? v
    : null;
}

function collectionAbilities(v: unknown, id: string): CollectionAbilities {
  const o = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  return {
    collectionId: typeof o["collectionId"] === "string" ? o["collectionId"] : id,
    role: role(o["role"]),
    createPage: ability(o["createPage"]),
    addMember: ability(o["addMember"]),
    removeMember: ability(o["removeMember"]),
    assertRelation: ability(o["assertRelation"]),
    runImport: ability(o["runImport"]),
  };
}

const parseSession = (raw: unknown): Session => {
  const o = obj(raw, "session");
  const actor = o["actor"] == null ? null : obj(o["actor"], "actor");
  const mode = o["mode"];
  return {
    mode: mode === "sso" || mode === "dev" ? mode : "none",
    sso: o["sso"] === true,
    devAuth: o["devAuth"] === true,
    authenticated: o["authenticated"] === true,
    viaCookie: o["viaCookie"] === true,
    actor: actor && {
      id: str(actor["id"], "actor.id"),
      name: str(actor["name"], "actor.name"),
      kind: actor["kind"] === "agent" ? "agent" : "person",
    },
    orgRole: text(o["orgRole"]),
    csrfToken: text(o["csrfToken"]),
    // The server sends this lower-cased. Defaulted rather than required so an
    // older server does not break the sign-in screen.
    csrfHeader: text(o["csrfHeader"]) ?? "x-canon-csrf",
    loginUrl: text(o["loginUrl"]),
  };
};

function parseCollection(row: unknown): Collection {
  const o = obj(row, "collection");
  const id = str(o["id"], "collection.id");
  return {
    id,
    name: str(o["name"], "collection.name"),
    description: text(o["description"]) ?? "",
    restricted: o["restricted"] === true,
    createdAt: text(o["createdAt"]) ?? "",
    archivedAt: text(o["archivedAt"]),
    archivedPages: num(o["archivedPages"]),
    abilities: collectionAbilities(o["abilities"], id),
  };
}

/** A BARE ARRAY, not `{ collections: [...] }`. Read off the server. */
const parseCollections = (raw: unknown): Collection[] =>
  arr(raw, "collections").map(parseCollection);

function parsePageNode(row: unknown): PageNode {
  const o = obj(row, "page");
  return {
    id: str(o["id"], "page.id"),
    collectionId: text(o["collectionId"]) ?? "",
    parentId: text(o["parentId"]),
    position: num(o["position"]),
    type: (text(o["type"]) ?? "note") as PageNode["type"],
    title: str(o["title"], "page.title"),
    status: (text(o["status"]) ?? "draft") as PageNode["status"],
    pageStanding: text(o["pageStanding"]),
    ownerId: text(o["ownerId"]),
    approverId: text(o["approverId"]),
    effectiveDate: text(o["effectiveDate"]),
    reviewDate: text(o["reviewDate"]),
    currentVersion: maybeNum(o["currentVersion"]),
    createdAt: text(o["createdAt"]) ?? "",
    supersededBy: text(o["supersededBy"]),
    children: arr(o["children"] ?? [], "page.children").map(parsePageNode),
  };
}

const parseTree = (raw: unknown): PageNode[] => arr(raw, "tree").map(parsePageNode);

const parsePage = (raw: unknown): PageDetail => {
  const o = obj(raw, "page");
  const node = parsePageNode(raw);
  const a = typeof o["abilities"] === "object" && o["abilities"] !== null
    ? (o["abilities"] as Record<string, unknown>)
    : {};
  const { children: _children, ...rest } = node;
  return {
    ...rest,
    effectiveDateBasis: text(o["effectiveDateBasis"]),
    current: o["current"] == null ? null : parseVersion(o["current"]),
    abilities: {
      role: role(a["role"]),
      edit: ability(a["edit"]),
      comment: ability(a["comment"]),
      submit: ability(a["submit"]),
      approve: ability(a["approve"]),
      sendBack: ability(a["sendBack"]),
      withdraw: ability(a["withdraw"]),
      archive: ability(a["archive"]),
      assertRelation: ability(a["assertRelation"]),
    },
    withheldLinks: arr(o["withheldLinks"] ?? [], "page.withheldLinks"),
  };
};

function parseQueuedPage(row: unknown): QueuedPage {
  const o = obj(row, "queue.page");
  return {
    // `pageId`, not `id` — the queue composes the query surface, which names it
    // differently from the tree. Getting this wrong makes every link in the
    // queue point at `/pages/undefined`.
    pageId: str(o["pageId"], "queue.page.pageId"),
    collectionId: text(o["collectionId"]) ?? "",
    type: (text(o["type"]) ?? "note") as QueuedPage["type"],
    title: str(o["title"], "queue.page.title"),
    status: (text(o["status"]) ?? "draft") as QueuedPage["status"],
    ownerId: text(o["ownerId"]),
    reviewDate: text(o["reviewDate"]),
    updatedAt: text(o["updatedAt"]) ?? "",
    pastReview: o["pastReview"] === true,
    backdated: o["backdated"] === true,
    backdatedWithoutBasis: o["backdatedWithoutBasis"] === true,
    notYetInForce: o["notYetInForce"] === true,
  };
}

const parseQueue = (raw: unknown): WorkQueue => {
  const o = obj(raw, "queue");
  const strand = (key: string): QueuedPage[] =>
    arr(o[key] ?? [], `queue.${key}`).map(parseQueuedPage);
  const c = typeof o["counts"] === "object" && o["counts"] !== null
    ? (o["counts"] as Record<string, unknown>)
    : {};
  return {
    actorId: text(o["actorId"]) ?? "",
    at: text(o["at"]) ?? "",
    awaitingMyApproval: strand("awaitingMyApproval"),
    sentBackToMe: strand("sentBackToMe"),
    myPagesPastReview: strand("myPagesPastReview"),
    myDrafts: strand("myDrafts"),
    awaitingSomebodyElse: strand("awaitingSomebodyElse"),
    notices: arr(o["notices"] ?? [], "queue.notices").map((row): Notice => {
      const n = obj(row, "queue.notice");
      return {
        id: str(n["id"], "notice.id"),
        kind: text(n["kind"]) ?? "",
        subject: text(n["subject"]) ?? "",
        body: text(n["body"]) ?? "",
        link: text(n["link"]),
        createdAt: text(n["createdAt"]) ?? "",
      };
    }),
    counts: {
      awaitingMyApproval: num(c["awaitingMyApproval"]),
      sentBackToMe: num(c["sentBackToMe"]),
      myPagesPastReview: num(c["myPagesPastReview"]),
      myDrafts: num(c["myDrafts"]),
      conflictsOnMyPages: num(c["conflictsOnMyPages"]),
      divergencesOnMyPages: num(c["divergencesOnMyPages"]),
      accessRequests: num(c["accessRequests"]),
      notices: num(c["notices"]),
      total: num(c["total"]),
    },
    truncated: o["truncated"] === true,
  };
};

const parseSearch = (raw: unknown): SearchHit[] =>
  arr(raw, "search").map((row) => {
    const o = obj(row, "search.hit");
    return {
      pageId: str(o["pageId"], "hit.pageId"),
      title: str(o["title"], "hit.title"),
      collectionId: text(o["collectionId"]) ?? "",
      type: (text(o["type"]) ?? "note") as SearchHit["type"],
      status: (text(o["status"]) ?? "draft") as SearchHit["status"],
      pageStanding: text(o["pageStanding"]),
      reviewDate: text(o["reviewDate"]),
      ownerId: text(o["ownerId"]),
      snippet: text(o["snippet"]) ?? "",
      supersededBy: text(o["supersededBy"]),
    };
  });

function parseVersion(raw: unknown): PageVersion {
  const o = obj(raw, "version");
  const f = typeof o["fields"] === "object" && o["fields"] !== null
    ? (o["fields"] as Record<string, unknown>)
    : {};
  return {
    pageId: text(o["pageId"]) ?? "",
    // `number`, not `version`. Getting this wrong renders every entry in the
    // history as "Version undefined".
    number: num(o["number"]),
    title: text(o["title"]) ?? "",
    body: text(o["body"]) ?? "",
    fields: {
      ownerId: text(f["ownerId"]),
      approverId: text(f["approverId"]),
      effectiveDate: text(f["effectiveDate"]),
      effectiveDateBasis: text(f["effectiveDateBasis"]),
      reviewDate: text(f["reviewDate"]),
    },
    authorId: text(o["authorId"]) ?? "",
    note: text(o["note"]),
    createdAt: text(o["createdAt"]) ?? "",
  };
}

const parseVersions = (raw: unknown): PageVersion[] =>
  arr(raw, "versions").map(parseVersion);

const parseComments = (raw: unknown): Comment[] =>
  arr(raw, "comments").map((row) => {
    const o = obj(row, "comment");
    return {
      id: str(o["id"], "comment.id"),
      pageId: text(o["pageId"]) ?? "",
      authorId: text(o["authorId"]) ?? "",
      authorKind: o["authorKind"] === "agent" ? "agent" : "person",
      body: text(o["body"]) ?? "",
      anchor: text(o["anchor"]),
      resolvedAt: text(o["resolvedAt"]),
      resolvedBy: text(o["resolvedBy"]),
      createdAt: text(o["createdAt"]) ?? "",
      sentBack: o["sentBack"] === true,
    };
  });

const parseDraft = (raw: unknown): Draft => {
  const o = obj(raw, "draft");
  const f = typeof o["fields"] === "object" && o["fields"] !== null
    ? (o["fields"] as Record<string, unknown>)
    : {};
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    pageId: text(o["pageId"]) ?? "",
    title: text(o["title"]) ?? "",
    body: text(o["body"]) ?? "",
    fields: {
      ownerId: text(f["ownerId"]),
      approverId: text(f["approverId"]),
      effectiveDate: text(f["effectiveDate"]),
      effectiveDateBasis: text(f["effectiveDateBasis"]),
      reviewDate: text(f["reviewDate"]),
      ...(Array.isArray(f["aliases"]) ? { aliases: strings(f["aliases"]) } : {}),
    },
    editorId: text(o["editorId"]) ?? "",
    baseVersion: maybeNum(o["baseVersion"]),
    updatedAt: text(o["updatedAt"]) ?? "",
    warnings: strings(o["warnings"]),
    linkWarnings: strings(o["linkWarnings"]),
  };
};

const parseMembers = (raw: unknown): Member[] =>
  arr(raw, "members").map((row) => {
    const o = obj(row, "member");
    return {
      actorId: str(o["actorId"], "member.actorId"),
      // An unrecognised role reads as the LEAST privilege, never the most.
      role: (role(o["role"]) ?? "view") as Member["role"],
    };
  });

const parseAudit = (raw: unknown): AuditEvent[] =>
  arr(raw, "audit").map((row) => {
    const o = obj(row, "audit.event");
    return {
      id: num(o["id"]),
      at: text(o["at"]) ?? "",
      actorId: text(o["actorId"]) ?? "",
      actorKind: o["actorKind"] === "agent" ? "agent" : "person",
      action: str(o["action"], "event.action"),
      collectionId: text(o["collectionId"]),
      pageId: text(o["pageId"]),
      pageTitle: text(o["pageTitle"]),
      collectionName: text(o["collectionName"]),
      details:
        typeof o["details"] === "object" && o["details"] !== null
          ? (o["details"] as Record<string, unknown>)
          : {},
    };
  });

const parseAuditSummary = (raw: unknown): AuditSummary => {
  const o = obj(raw, "audit.summary");
  return {
    matching: num(o["matching"]),
    actions: arr(o["actions"] ?? [], "summary.actions").map((row) => {
      const a = obj(row, "summary.action");
      return { action: str(a["action"], "action"), count: num(a["count"]) };
    }),
  };
};

function parseGap(row: unknown): Gap {
  const o = obj(row, "gap");
  const status = o["status"];
  return {
    id: str(o["id"], "gap.id"),
    question: str(o["question"], "gap.question"),
    collectionId: text(o["collectionId"]),
    timesAsked: num(o["timesAsked"]),
    firstAskedAt: text(o["firstAskedAt"]) ?? "",
    lastAskedAt: text(o["lastAskedAt"]) ?? "",
    nearest: arr(o["nearest"] ?? [], "gap.nearest").map((n) => {
      const near = obj(n, "gap.nearest[]");
      return { pageId: str(near["pageId"], "pageId"), title: text(near["title"]) ?? "" };
    }),
    status: status === "resolved" || status === "dismissed" ? status : "open",
    resolution: text(o["resolution"]),
    resolvedAt: text(o["resolvedAt"]),
    // Left ABSENT rather than defaulted: "the probe did not run" and "the
    // record cannot answer this" are different facts, and collapsing them
    // would make the screen assert the second when it only knows the first.
    ...(typeof o["nowAnswers"] === "boolean" ? { nowAnswers: o["nowAnswers"] } : {}),
  };
}

const parseGaps = (raw: unknown): GapsView => {
  const o = obj(raw, "gaps");
  return {
    scope: text(o["scope"]) ?? "",
    collections: arr(o["collections"] ?? [], "gaps.collections").map((row) => {
      const c = obj(row, "gaps.collection");
      return { id: str(c["id"], "id"), name: text(c["name"]) ?? "" };
    }),
    gaps: arr(o["gaps"] ?? [], "gaps.gaps").map(parseGap),
  };
};

const parseSources = (raw: unknown): Source[] =>
  arr(raw, "sources").map((row) => {
    const o = obj(row, "source");
    const a = typeof o["abilities"] === "object" && o["abilities"] !== null
      ? (o["abilities"] as Record<string, unknown>)
      : {};
    return {
      id: str(o["id"], "source.id"),
      name: str(o["name"], "source.name"),
      kind: text(o["kind"]) ?? "",
      baseUrl: text(o["baseUrl"]) ?? "",
      authMode: text(o["authMode"]) ?? "",
      freshnessWindowMs: num(o["freshnessWindowMs"]),
      collectionIds: arr(o["collectionIds"] ?? [], "source.collectionIds").map((c) =>
        str(c, "collectionId"),
      ),
      createdAt: text(o["createdAt"]) ?? "",
      abilities: { edit: ability(a["edit"]), delete: ability(a["delete"]) },
    };
  });

const parseImports = (raw: unknown): ImportRun[] =>
  arr(raw, "imports").map((row) => {
    const o = obj(row, "import.run");
    const c = typeof o["counts"] === "object" && o["counts"] !== null
      ? (o["counts"] as Record<string, unknown>)
      : {};
    return {
      runId: str(o["runId"], "run.runId"),
      source: text(o["source"]) ?? "",
      path: text(o["path"]) ?? "",
      collectionId: text(o["collectionId"]) ?? "",
      type: (text(o["type"]) ?? "note") as ImportRun["type"],
      actorId: text(o["actorId"]) ?? "",
      hierarchy: (text(o["hierarchy"]) ?? "flat") as ImportRun["hierarchy"],
      startedAt: text(o["startedAt"]) ?? "",
      finishedAt: text(o["finishedAt"]) ?? "",
      counts: {
        found: num(c["found"]),
        imported: num(c["imported"]),
        updated: num(c["updated"]),
        skipped: num(c["skipped"]),
        failed: num(c["failed"]),
      },
    };
  });

const parseImportRun = (raw: unknown): ImportRunDetail => {
  const o = obj(raw, "import.run");
  const [row] = parseImports([raw]);
  const f = typeof o["fields"] === "object" && o["fields"] !== null
    ? (o["fields"] as Record<string, unknown>)
    : {};
  return {
    ...row!,
    fields: {
      ownerId: text(f["ownerId"]),
      approverId: text(f["approverId"]),
      reviewDate: text(f["reviewDate"]),
    },
    files: arr(o["files"] ?? [], "run.files").map((entry) => {
      const e = obj(entry, "run.file");
      const outcome = e["outcome"];
      return {
        file: str(e["file"], "file.file"),
        outcome:
          outcome === "imported" || outcome === "updated" || outcome === "skipped"
            ? outcome
            // Anything unrecognised is treated as a FAILURE, never as a
            // success: a run that quietly reported an unknown outcome as
            // "imported" would tell somebody a page landed when it did not.
            : "failed",
        pageId: text(e["pageId"]),
        title: text(e["title"]),
        parentFile: text(e["parentFile"]),
        published: e["published"] === true,
        reason: text(e["reason"]),
      };
    }),
  };
};

/** A query string built from only the entries that have a value. */
function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

export interface AuditFilter {
  collectionId?: string;
  pageId?: string;
  actorId?: string;
  action?: string;
  before?: number;
  limit?: number;
}

const parseActors = (raw: unknown): Actor[] =>
  arr(raw, "actors").map((row) => {
    const o = obj(row, "actor");
    return {
      id: str(o["id"], "actor.id"),
      name: str(o["name"], "actor.name"),
      kind: o["kind"] === "agent" ? "agent" : "person",
    };
  });

export interface NewCollection {
  name: string;
  description: string;
  restricted: boolean;
}

export const api = {
  session: () => request("GET", "/auth/session", parseSession),
  /** The development identity picker. Present only where the server was
   *  started with the dev door open; a 404 here is the normal answer on a real
   *  deployment, not a fault. */
  devActors: () => request("GET", "/auth/dev/actors", parseActors),
  createActor: (body: { name: string; kind: "person" | "agent"; email?: string; registryRef?: string }) =>
    request("POST", "/actors", (raw) => parseActors([raw])[0]!, body),

  collections: () => request("GET", "/collections", parseCollections),
  createCollection: (body: NewCollection) =>
    request("POST", "/collections", parseCollection, body),
  collection: (id: string) =>
    request("GET", `/collections/${encodeURIComponent(id)}`, parseCollection),
  tree: (id: string) =>
    request("GET", `/collections/${encodeURIComponent(id)}/tree`, parseTree),

  page: (id: string) => request("GET", `/pages/${encodeURIComponent(id)}`, parsePage),
  versions: (id: string) =>
    request("GET", `/pages/${encodeURIComponent(id)}/versions`, parseVersions),
  version: (id: string, n: number) =>
    request("GET", `/pages/${encodeURIComponent(id)}/versions/${n}`, parseVersion),
  /** The editor's opening question. An empty body writes NOTHING and takes no
   *  lock — it answers with what the editor would hold, or refuses 423 naming
   *  whoever is already editing. */
  openDraft: (id: string) =>
    request("PUT", `/pages/${encodeURIComponent(id)}/draft`, parseDraft, {}),
  saveDraft: (id: string, draft: { title: string; body: string; fields: unknown }) =>
    request("PUT", `/pages/${encodeURIComponent(id)}/draft`, parseDraft, draft),
  discardDraft: (id: string) =>
    request("DELETE", `/pages/${encodeURIComponent(id)}/draft`, () => null),
  submit: (id: string) =>
    request("POST", `/pages/${encodeURIComponent(id)}/submit`, () => null, {}),
  publish: (id: string, note?: string) =>
    request("POST", `/pages/${encodeURIComponent(id)}/publish`, () => null,
      note ? { note } : {}),

  members: (collectionId: string) =>
    request("GET", `/collections/${encodeURIComponent(collectionId)}/members`, parseMembers),
  setMember: (collectionId: string, actorId: string, memberRole: string) =>
    request("PUT",
      `/collections/${encodeURIComponent(collectionId)}/members/${encodeURIComponent(actorId)}`,
      () => null, { role: memberRole }),
  removeMember: (collectionId: string, actorId: string) =>
    request("DELETE",
      `/collections/${encodeURIComponent(collectionId)}/members/${encodeURIComponent(actorId)}`,
      () => null),
  actors: (collectionId?: string) =>
    request("GET", `/actors${qs({ collection: collectionId })}`, parseActors),

  comments: (id: string) =>
    request("GET", `/pages/${encodeURIComponent(id)}/comments`, parseComments),
  addComment: (id: string, body: string) =>
    request("POST", `/pages/${encodeURIComponent(id)}/comments`, () => null, { body }),
  resolveComment: (commentId: string) =>
    request("POST", `/comments/${encodeURIComponent(commentId)}/resolve`, () => null, {}),
  reopenComment: (commentId: string) =>
    request("POST", `/comments/${encodeURIComponent(commentId)}/reopen`, () => null, {}),

  audit: (filter: AuditFilter = {}) => request("GET", `/audit${qs({ ...filter })}`, parseAudit),
  auditSummary: (filter: AuditFilter = {}) => {
    // The summary counts the whole filtered population, so paging parameters
    // must not reach it — `before` would make it summarise one page of the log
    // and call that the total.
    const { before: _before, limit: _limit, ...rest } = filter;
    return request("GET", `/audit/summary${qs({ ...rest })}`, parseAuditSummary);
  },

  queue: () => request("GET", "/queue", parseQueue),
  approve: (pageId: string, note?: string) =>
    request("POST", `/pages/${encodeURIComponent(pageId)}/approve`, () => null,
      note ? { note } : {}),
  sendBack: (pageId: string, note: string) =>
    request("POST", `/pages/${encodeURIComponent(pageId)}/send-back`, () => null, { note }),
  withdraw: (pageId: string) =>
    request("POST", `/pages/${encodeURIComponent(pageId)}/withdraw`, () => null, {}),

  search: (q: string, filters: { collectionId?: string; status?: string } = {}) =>
    request("GET", `/search${qs({ q, ...filters })}`, parseSearch),

  gaps: (status?: string) => request("GET", `/gaps${qs({ status })}`, parseGaps),
  sources: () => request("GET", "/sources", parseSources),
  imports: () => request("GET", "/imports", parseImports),
  importRun: (id: string) =>
    request("GET", `/imports/${encodeURIComponent(id)}`, parseImportRun),
};
