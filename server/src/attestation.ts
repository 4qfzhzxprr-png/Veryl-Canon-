import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AUDIT_CHAIN_ALGORITHM,
  AUDIT_CHAIN_FORMAT,
  AuditChainHead,
  AuditChainVerification,
  CHAIN_HASH_RECIPE,
  CHAIN_LIMITS,
  CHAIN_PROVES,
  GENESIS_HASH,
  auditChainHead,
  linkFor,
  verifyAuditChain,
} from './auditchain.js';
import { RawResponse } from './csv.js';
import {
  Actor,
  ActorKind,
  CanonError,
  DocType,
  PageFields,
  PageStatus,
  Role,
} from './model.js';

// Attestation and export (FEATURES.md §7): "Prove the state of the record:
// export any page with its full history, approvals, and audit trail. Show an
// auditor exactly what the policy said on a given date and who had approved
// it."
//
// Canon already held every piece of this. Immutable versions, approvals
// granted by a named approver, an append-only audit log with a hash chain over
// it. What was missing was the assembly — the artefact an auditor is actually
// handed. That is what this file builds, and the whole of it is a DERIVATION
// from history rather than a snapshot anyone stores:
//
//   * `pageAsOf` reconstructs what a page said, what its fields were, what
//     standing it had, and who had granted that standing, at one instant.
//   * `pageAttestation` assembles the whole record of one page — every
//     version, every field change, every status change with its actor, every
//     approval, and every audit event touching it, each with its chain link.
//   * `collectionAttestation` does the register: which pages held the
//     Canonical mark in a collection on a given date, who owned them, who
//     approved them, and when each is next due for review.
//
// Two renderings from one builder, because the two readers are different
// people: JSON for a machine that will diff it or load it, and a
// self-contained HTML document for a person who will read it and print it to
// PDF. No PDF library, no template engine, no dependency of any kind — the
// HTML carries its own CSS inline and references nothing outside itself, so it
// survives being emailed, archived, and opened years later on a machine with
// no network.
//
// WHY RECONSTRUCTION RATHER THAN A STORED SNAPSHOT. A stored snapshot is a
// second copy of the record, and DATA-BACKBONE.md §2 principle 1 says a fact
// lives in exactly one place. It would also be a copy nobody could check: an
// auditor holding a snapshot has to trust that whatever wrote it was honest at
// the time. A reconstruction can be recomputed from the immutable history by
// anyone with access to the record, and it will produce the same answer,
// because the inputs — versions and audit events — are append-only.

// ---------------------------------------------------------------------------
// Honesty about time

/**
 * The instant an as-of question is asked about. Normalised to ISO-8601 UTC
 * with milliseconds, which is the shape every timestamp in the record already
 * has, so comparison is lexicographic and needs no date parsing in SQL.
 *
 * A bare date (`2026-03-01`) means the START of that day, not the end. That is
 * the reading that makes "what did the policy say on 1 March" answerable
 * without ambiguity, and it is stated in the bundle so nobody has to guess:
 * a version published at 14:00 on 1 March was NOT what the policy said at the
 * start of that day, and answering otherwise would be answering a different
 * question from the one asked.
 */
export function normalizeInstant(at: string): string {
  const raw = String(at ?? '').trim();
  if (!raw) throw new CanonError('invalid', 'An as-of query needs a timestamp: ?at=<ISO 8601>');
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new CanonError('invalid', `Not a timestamp Canon can read: '${at}'. Use ISO 8601, e.g. 2026-03-01T09:00:00Z`);
  }
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Shapes

export interface NamedActor {
  id: string;
  name: string;
  kind: ActorKind;
}

export interface AttestedVersion {
  number: number;
  title: string;
  body: string;
  fields: PageFields;
  authorId: string;
  authorName: string;
  note: string | null;
  createdAt: string;
}

export interface FieldChange {
  version: number;
  at: string;
  field: keyof PageFields;
  from: string | null;
  to: string | null;
  byId: string;
  byName: string;
}

export interface StatusChange {
  at: string;
  status: PageStatus;
  actorId: string;
  actorName: string;
  action: string;
  eventId: number;
  /** The version the change applied to, where the event named one. */
  version: number | null;
  /** A send-back's comment; the only status change that carries prose. */
  comment: string | null;
}

export interface Approval {
  at: string;
  approverId: string;
  approverName: string;
  version: number | null;
  eventId: number;
  note: string | null;
}

export interface AttestedAuditEvent {
  id: number;
  at: string;
  actorId: string;
  actorName: string;
  actorKind: ActorKind;
  action: string;
  collectionId: string | null;
  pageId: string | null;
  details: Record<string, unknown>;
  /** The chain link, or null where the event predates the chain (migration). */
  chain: { prevHash: string; hash: string } | null;
}

export type AsOfReason = 'ok' | 'not_yet_created' | 'no_published_version';

export interface PageAsOf {
  pageId: string;
  collectionId: string;
  /** The instant asked about, normalised. */
  at: string;
  existed: boolean;
  reason: AsOfReason;
  /** Plain English for the reason. Read by a person, not switched on by code. */
  answer: string;
  createdAt: string;
  type: DocType;
  /** The title AS IT WAS at `at`, not as it is now. */
  title: string | null;
  /** The status AS IT WAS, derived from the audit log. */
  status: PageStatus | null;
  /** Was this page Canonical at that exact instant? */
  canonical: boolean;
  /** Set when the page had been archived by `at`. */
  archivedAt: string | null;
  /** The version current at `at`, with its fields as they were. */
  version: AttestedVersion | null;
  /** The version's structured fields, hoisted for readers who want just these. */
  fields: PageFields | null;
  /** The approval that granted the standing this page held at `at`. */
  approval: Approval | null;
  /** Every status change at or before `at`, oldest first: the derivation. */
  statusHistory: StatusChange[];
}

export interface AttestationManifest {
  format: 'veryl-canon-attestation-v1';
  subject: { kind: 'page' | 'collection'; id: string; title: string; collectionId: string | null };
  asserts: string[];
  generatedAt: string;
  generatedBy: NamedActor;
  /** The audit event recording that this bundle was generated. */
  generationEventId: number | null;
  at: string | null;
  auditChain: {
    format: string;
    algorithm: string;
    genesisHash: string;
    recipe: string;
    head: AuditChainHead | null;
    chainedFromEventId: number;
    unchainedEventsBefore: number;
    verifiedAtGeneration: { ok: boolean; verified: number; firstBreak: AuditChainVerification['firstBreak'] };
    proves: string;
    limits: string;
  };
  /** SHA-256 over the canonical JSON of everything in this bundle but the manifest. */
  contentDigest: string;
  howToVerify: string[];
  limits: string[];
}

export interface PageAttestation {
  manifest: AttestationManifest;
  page: {
    id: string;
    collectionId: string;
    collectionName: string;
    type: DocType;
    title: string;
    status: PageStatus;
    ownerId: string | null;
    approverId: string | null;
    effectiveDate: string | null;
    reviewDate: string | null;
    currentVersion: number | null;
    createdById: string;
    createdAt: string;
  };
  versions: AttestedVersion[];
  fieldHistory: FieldChange[];
  statusHistory: StatusChange[];
  approvals: Approval[];
  auditEvents: AttestedAuditEvent[];
  asOf: PageAsOf | null;
  actors: NamedActor[];
}

export interface RegisterEntry {
  pageId: string;
  title: string;
  type: DocType;
  status: PageStatus;
  canonical: boolean;
  version: number | null;
  publishedAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  approverId: string | null;
  approverName: string | null;
  approvedAt: string | null;
  effectiveDate: string | null;
  reviewDate: string | null;
  pastReview: boolean;
}

export interface CollectionAttestation {
  manifest: AttestationManifest;
  collection: { id: string; name: string; description: string; restricted: boolean };
  /** Pages holding the Canonical mark at `at` — the register itself. */
  register: RegisterEntry[];
  /** Pages in the collection that did NOT hold the mark, named rather than hidden. */
  notCanonical: RegisterEntry[];
  truncated: { limit: number; total: number } | null;
  actors: NamedActor[];
}

// ---------------------------------------------------------------------------
// The status machine, read backwards out of the audit log
//
// A page's status is a column on `pages`, and a column holds one value: the
// current one. The HISTORY of that column is not stored anywhere as such — and
// it does not need to be, because every transition is already an audit event
// with an actor and a timestamp. This map is the only place that knowledge
// lives; adding a transition to the store means adding a line here, and a
// transition that is not audited would be a transition nobody can attest to,
// which is a bug in the transition rather than in this file.

const STATUS_EVENTS: Record<string, PageStatus | 'from_details'> = {
  'page.create': 'draft',
  'page.publish': 'from_details', // details.status: 'draft' after an ordinary publish, 'canonical' after approval
  'page.submit': 'in_review',
  'page.approve': 'canonical',
  'page.send_back': 'draft',
  'page.archive': 'archived',
  'page.needs_update': 'needs_update',
};

const PAGE_STATUSES: readonly PageStatus[] = ['draft', 'in_review', 'canonical', 'needs_update', 'archived'];

function statusFromEvent(action: string, details: Record<string, unknown>): PageStatus | null {
  const mapped = STATUS_EVENTS[action];
  if (!mapped) return null;
  if (mapped !== 'from_details') return mapped;
  const named = details.status;
  return typeof named === 'string' && (PAGE_STATUSES as readonly string[]).includes(named)
    ? (named as PageStatus)
    : 'draft';
}

// ---------------------------------------------------------------------------
// The service

/** The slice of CanonStore this service needs; CanonStore satisfies it. */
export interface AttestationHost {
  getActor(id: string): Actor;
  requireRoleFor(actorId: string, collectionId: string, needed: Role): void;
  recordAudit(
    actorId: string,
    action: string,
    ctx?: { collectionId?: string; pageId?: string; details?: Record<string, unknown> },
  ): void;
}

/** Pages read into one collection register. Past it the register says so. */
export const REGISTER_PAGE_CAP = 2000;

export class AttestationService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: AttestationHost,
  ) {}

  // ---- point in time ---------------------------------------------------

  /**
   * What did this page say at that instant, and who had approved it.
   *
   * Permission: `view` on the page's collection, the same bar as reading the
   * page today. An attestation reveals nothing a reader could not assemble by
   * hand from `GET /pages/:id/versions` and `GET /audit`; what it adds is the
   * assembly, not the access.
   */
  asOf(actorId: string, pageId: string, at: string): PageAsOf {
    const instant = normalizeInstant(at);
    const page = this.pageRow(pageId);
    const collectionId = page.collection_id as string;
    this.host.requireRoleFor(actorId, collectionId, 'view');
    // A reconstruction hands back the body of a version, so on a restricted
    // collection it is a view and is logged as one — the same rule
    // `getPage({ logView: true })` applies, reached by a different door.
    // Without this line, as-of would be the one way to read restricted
    // material without leaving a `page.view` behind, and that is exactly the
    // hole an auditor looks for. It is not audited as its own act, because it
    // is not one: an attestation BUNDLE is the act, and it writes
    // `attestation.generate`.
    const restricted = this.db.prepare('SELECT restricted FROM collections WHERE id = ?').get(collectionId) as
      | { restricted: number }
      | undefined;
    if (restricted?.restricted === 1) {
      this.host.recordAudit(actorId, 'page.view', {
        collectionId,
        pageId,
        details: { via: 'as-of', at: instant },
      });
    }
    return this.reconstruct(page, instant);
  }

  /**
   * The reconstruction proper, with permission already settled by the caller.
   * Kept separate so the collection register can run it per page without
   * re-asking the same permission question once per row.
   */
  private reconstruct(page: Record<string, unknown>, instant: string): PageAsOf {
    const pageId = page.id as string;
    const createdAt = page.created_at as string;
    const type = page.type as DocType;
    const collectionId = page.collection_id as string;

    // Did it exist? The page's own creation timestamp answers, not the
    // presence of a version: a page created and never published existed, and
    // saying it did not would be a lie about the record.
    if (instant < createdAt) {
      return {
        pageId,
        collectionId,
        at: instant,
        existed: false,
        reason: 'not_yet_created',
        answer:
          `This page did not exist at ${instant}. It was created at ${createdAt}. ` +
          'Canon answers with nothing rather than with the nearest version, because the nearest version is an ' +
          'answer to a different question.',
        createdAt,
        type,
        title: null,
        status: null,
        canonical: false,
        archivedAt: null,
        version: null,
        fields: null,
        approval: null,
        statusHistory: [],
      };
    }

    const versionRow = this.db
      .prepare(
        `SELECT * FROM page_versions
          WHERE page_id = ? AND created_at <= ?
          ORDER BY number DESC LIMIT 1`,
      )
      .get(pageId, instant) as Record<string, unknown> | undefined;
    const version = versionRow ? this.toAttestedVersion(versionRow) : null;

    // Events at or before the instant, PLUS the events that complete the act
    // that produced the version standing at it. See `completingEvents` — this
    // is the difference between "version 1 is current, status In Review" and
    // an answer that is internally consistent.
    const events = [
      ...this.pageEvents(pageId, instant),
      ...(version ? this.completingEvents(pageId, instant, version.number) : []),
    ];
    const statusHistory = this.statusHistory(events);
    const archivedAt = statusHistory.find((s) => s.status === 'archived')?.at ?? null;

    // The status as it was: the last status-bearing event at or before the
    // instant. A page with no events at all (impossible through the store,
    // which audits creation) reads as Draft, which is what creation means.
    const status: PageStatus = statusHistory.length ? statusHistory[statusHistory.length - 1]!.status : 'draft';
    const canonical = status === 'canonical';

    // The approval that granted the standing held at that instant. Matched to
    // the version, not merely "the last approval": a page approved at v3 and
    // then republished at v4 (which drops the mark) must not report v3's
    // approval as though it covered v4.
    const approval =
      version === null
        ? null
        : (this.approvals(events).filter((a) => a.version === version.number).pop() ?? null);

    const reason: AsOfReason = version === null ? 'no_published_version' : 'ok';
    const answer =
      version === null
        ? `This page existed at ${instant} but had no published version: it was created at ${createdAt} and ` +
          'nothing had been published yet. There is no text to attest to.'
        : `At ${instant} this page stood at version ${version.number}, published ${version.createdAt}, with the ` +
          `status ${status}.` +
          (canonical
            ? approval
              ? ` It held the Canonical mark, granted by ${approval.approverName} at ${approval.at}.`
              : ' It held the Canonical mark; no approval event names this version, which should not happen and ' +
                'is reported rather than smoothed over.'
            : archivedAt
              ? ` It had been archived at ${archivedAt} and was not the official record.`
              : ' It did not hold the Canonical mark at that instant.');

    return {
      pageId,
      collectionId,
      at: instant,
      existed: true,
      reason,
      answer,
      createdAt,
      type,
      title: version?.title ?? this.creationTitle(events) ?? (page.title as string),
      status,
      canonical,
      archivedAt,
      version,
      fields: version?.fields ?? null,
      approval,
      statusHistory,
    };
  }

  // ---- the page bundle -------------------------------------------------

  /**
   * The artefact an auditor is handed for one page. Generating one is itself
   * an audited act — recorded BEFORE the bundle is assembled, so the
   * generation event is inside the chain the manifest names, and the manifest
   * can point at its own event id: "this bundle is event N; ask Canon, or your
   * anchor, what the head hash was at N."
   */
  bundle(actorId: string, pageId: string, opts: { at?: string; format?: 'json' | 'html' } = {}): PageAttestation {
    const page = this.pageRow(pageId);
    const collectionId = page.collection_id as string;
    this.host.requireRoleFor(actorId, collectionId, 'view');
    const instant = opts.at ? normalizeInstant(opts.at) : null;

    this.host.recordAudit(actorId, 'attestation.generate', {
      collectionId,
      pageId,
      details: { subject: 'page', at: instant, format: opts.format ?? 'json' },
    });
    const generationEventId = this.lastEventId();

    const versions = (
      this.db.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY number').all(pageId) as Record<
        string,
        unknown
      >[]
    ).map((r) => this.toAttestedVersion(r));
    const events = this.pageEvents(pageId, null);
    const statusHistory = this.statusHistory(events);
    const approvals = this.approvals(events);
    const auditEvents = events.map((e) => this.toAttestedEvent(e));
    const asOf = instant ? this.reconstruct(page, instant) : null;
    const fieldHistory = this.fieldHistory(versions);

    const collection = this.db.prepare('SELECT name FROM collections WHERE id = ?').get(collectionId) as
      | { name: string }
      | undefined;

    const content = {
      page: {
        id: pageId,
        collectionId,
        collectionName: collection?.name ?? '(unknown collection)',
        type: page.type as DocType,
        title: page.title as string,
        status: page.status as PageStatus,
        ownerId: (page.owner_id as string) ?? null,
        approverId: (page.approver_id as string) ?? null,
        effectiveDate: (page.effective_date as string) ?? null,
        reviewDate: (page.review_date as string) ?? null,
        currentVersion: (page.current_version as number) ?? null,
        createdById: page.created_by as string,
        createdAt: page.created_at as string,
      },
      versions,
      fieldHistory,
      statusHistory,
      approvals,
      auditEvents,
      asOf,
      actors: this.namedActors([
        actorId,
        page.created_by as string,
        (page.owner_id as string) ?? null,
        (page.approver_id as string) ?? null,
        ...versions.map((v) => v.authorId),
        ...statusHistory.map((s) => s.actorId),
        ...auditEvents.map((e) => e.actorId),
      ]),
    };

    return {
      manifest: this.manifest({
        actorId,
        subject: { kind: 'page', id: pageId, title: page.title as string, collectionId },
        at: instant,
        generationEventId,
        content,
        asserts: [
          `Every published version of this page held by Veryl Canon at generation time (${versions.length}).`,
          'The author, timestamp and note of each version, and the structured fields as that version carried them.',
          'Every status change, with the actor who made it and when.',
          'Every approval, naming the approver and the version approved.',
          `Every audit event Canon holds that names this page (${auditEvents.length}), each with its hash-chain link.`,
          ...(instant
            ? [`What this page said at ${instant}, what standing it held then, and who had granted that standing.`]
            : []),
        ],
      }),
      ...content,
    };
  }

  // ---- the collection register -----------------------------------------

  /**
   * The register a compliance lead is actually asked for: which pages in this
   * collection held the Canonical mark on a given date, who owned them, who
   * approved them, and when each is due for review.
   *
   * It falls out of the page reconstruction rather than duplicating it: one
   * `reconstruct` per page, with the collection's permission asked once. Pages
   * that did NOT hold the mark are listed separately rather than dropped —
   * "these are the twelve Canonical policies" is only a useful sentence
   * alongside "and these four were not".
   */
  register(
    actorId: string,
    collectionId: string,
    opts: { at?: string; format?: 'json' | 'html' } = {},
  ): CollectionAttestation {
    const collection = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId) as
      | Record<string, unknown>
      | undefined;
    if (!collection) throw new CanonError('not_found', `No such collection: ${collectionId}`);
    this.host.requireRoleFor(actorId, collectionId, 'view');
    const instant = normalizeInstant(opts.at ?? new Date().toISOString());

    this.host.recordAudit(actorId, 'attestation.generate', {
      collectionId,
      details: { subject: 'collection', at: instant, format: opts.format ?? 'json' },
    });
    const generationEventId = this.lastEventId();

    const total = (
      this.db.prepare('SELECT COUNT(*) AS n FROM pages WHERE collection_id = ?').get(collectionId) as { n: number }
    ).n;
    const rows = this.db
      .prepare('SELECT * FROM pages WHERE collection_id = ? ORDER BY position, id LIMIT ?')
      .all(collectionId, REGISTER_PAGE_CAP) as Record<string, unknown>[];

    const register: RegisterEntry[] = [];
    const notCanonical: RegisterEntry[] = [];
    const actorIds: (string | null)[] = [actorId];
    for (const row of rows) {
      const asOf = this.reconstruct(row, instant);
      if (!asOf.existed) continue; // created after the date asked about
      const owner = asOf.fields?.ownerId ?? null;
      const approver = asOf.fields?.approverId ?? null;
      actorIds.push(owner, approver, asOf.approval?.approverId ?? null);
      const entry: RegisterEntry = {
        pageId: asOf.pageId,
        title: asOf.title ?? '(untitled)',
        type: asOf.type,
        status: asOf.status ?? 'draft',
        canonical: asOf.canonical,
        version: asOf.version?.number ?? null,
        publishedAt: asOf.version?.createdAt ?? null,
        ownerId: owner,
        ownerName: owner ? this.actorName(owner) : null,
        approverId: approver,
        approverName: approver ? this.actorName(approver) : null,
        approvedAt: asOf.approval?.at ?? null,
        effectiveDate: asOf.fields?.effectiveDate ?? null,
        reviewDate: asOf.fields?.reviewDate ?? null,
        pastReview: Boolean(asOf.fields?.reviewDate && asOf.fields.reviewDate < instant.slice(0, 10)),
      };
      (entry.canonical ? register : notCanonical).push(entry);
    }

    const content = {
      collection: {
        id: collectionId,
        name: collection.name as string,
        description: (collection.description as string) ?? '',
        restricted: (collection.restricted as number) === 1,
      },
      register,
      notCanonical,
      truncated: total > REGISTER_PAGE_CAP ? { limit: REGISTER_PAGE_CAP, total } : null,
      actors: this.namedActors(actorIds),
    };

    return {
      manifest: this.manifest({
        actorId,
        subject: { kind: 'collection', id: collectionId, title: collection.name as string, collectionId },
        at: instant,
        generationEventId,
        content,
        asserts: [
          `The pages of this collection that held the Canonical mark at ${instant} (${register.length}).`,
          `The pages that did not (${notCanonical.length}), named rather than omitted.`,
          'For each: the version standing at that instant, its owner and named approver, the approval that ' +
            'granted the mark, its effective date and its review date — all as they were then, not as they are now.',
        ],
      }),
      ...content,
    };
  }

  // ---- manifest --------------------------------------------------------

  private manifest(input: {
    actorId: string;
    subject: AttestationManifest['subject'];
    at: string | null;
    generationEventId: number | null;
    content: unknown;
    asserts: string[];
  }): AttestationManifest {
    const by = this.host.getActor(input.actorId);
    const verification = verifyAuditChain(this.db);
    return {
      format: 'veryl-canon-attestation-v1',
      subject: input.subject,
      asserts: input.asserts,
      generatedAt: new Date().toISOString(),
      generatedBy: { id: by.id, name: by.name, kind: by.kind },
      generationEventId: input.generationEventId,
      at: input.at,
      auditChain: {
        format: AUDIT_CHAIN_FORMAT,
        algorithm: AUDIT_CHAIN_ALGORITHM,
        genesisHash: GENESIS_HASH,
        recipe: CHAIN_HASH_RECIPE,
        head: auditChainHead(this.db),
        chainedFromEventId: verification.chainedFromEventId,
        unchainedEventsBefore: verification.unchained,
        verifiedAtGeneration: {
          ok: verification.ok,
          verified: verification.verified,
          firstBreak: verification.firstBreak,
        },
        proves: CHAIN_PROVES,
        limits: CHAIN_LIMITS,
      },
      contentDigest: contentDigest(input.content),
      howToVerify: HOW_TO_VERIFY,
      limits: BUNDLE_LIMITS,
    };
  }

  // ---- internals -------------------------------------------------------

  private pageRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return row;
  }

  private lastEventId(): number | null {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM audit_events').get() as { id: number | null };
    return row.id === null ? null : Number(row.id);
  }

  /**
   * The audit events naming this page, oldest first, optionally cut at an
   * instant. Permission was settled by the caller holding `view` on the page's
   * collection, which is exactly the rule `queryAudit` applies to an event
   * naming a collection — so this is the same answer that query would give,
   * assembled per page rather than per filter.
   */
  private pageEvents(pageId: string, until: string | null): Record<string, unknown>[] {
    const sql = until
      ? 'SELECT * FROM audit_events WHERE page_id = ? AND at <= ? ORDER BY id'
      : 'SELECT * FROM audit_events WHERE page_id = ? ORDER BY id';
    const params = until ? [pageId, until] : [pageId];
    return this.db.prepare(sql).all(...params) as Record<string, unknown>[];
  }

  /**
   * The events that finish the act the instant lands inside.
   *
   * Writing a version and recording the status it landed at are one act in the
   * store (`writeVersion`) but two rows with two timestamps, taken a fraction
   * apart. An instant falling in that gap — which is exactly what "as at the
   * moment version 2 was published" is — would otherwise reconstruct as
   * "version 2 stands, and the status is whatever it was before version 2 was
   * written". That is not a conservative answer, it is a wrong one: the two
   * halves describe different moments.
   *
   * So where a version stands at the instant, the `page.publish` /
   * `page.approve` event NAMING THAT VERSION NUMBER is counted even if its own
   * timestamp is a hair later. The match is exact and cannot over-reach: a
   * version number is written once, so at most one publish and one approval
   * can name it, and the first two publish-or-approve events after the instant
   * are the only candidates — anything later belongs to a version that did not
   * exist yet at the instant.
   */
  private completingEvents(pageId: string, instant: string, versionNumber: number): Record<string, unknown>[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events
          WHERE page_id = ? AND at > ? AND action IN ('page.publish', 'page.approve')
          ORDER BY id LIMIT 2`,
      )
      .all(pageId, instant) as Record<string, unknown>[];
    return rows.filter((row) => {
      const details = JSON.parse(row.details_json as string) as Record<string, unknown>;
      return details.version === versionNumber;
    });
  }

  private statusHistory(events: Record<string, unknown>[]): StatusChange[] {
    const out: StatusChange[] = [];
    for (const row of events) {
      const action = row.action as string;
      const details = JSON.parse(row.details_json as string) as Record<string, unknown>;
      const status = statusFromEvent(action, details);
      if (!status) continue;
      // A publish followed by an approval both land on `canonical` in the same
      // millisecond; the pair is kept rather than collapsed, because the two
      // events are two different acts (writing the version, granting the mark)
      // and an auditor asking "who granted this" wants to see both.
      const actorId = row.actor_id as string;
      out.push({
        at: row.at as string,
        status,
        actorId,
        actorName: this.actorName(actorId),
        action,
        eventId: Number(row.id),
        version: typeof details.version === 'number' ? details.version : null,
        comment: typeof details.comment === 'string' ? details.comment : null,
      });
    }
    return out;
  }

  private approvals(events: Record<string, unknown>[]): Approval[] {
    return events
      .filter((row) => row.action === 'page.approve')
      .map((row) => {
        const details = JSON.parse(row.details_json as string) as Record<string, unknown>;
        const approverId = row.actor_id as string;
        return {
          at: row.at as string,
          approverId,
          approverName: this.actorName(approverId),
          version: typeof details.version === 'number' ? details.version : null,
          eventId: Number(row.id),
          note: typeof details.note === 'string' ? details.note : null,
        };
      });
  }

  private creationTitle(events: Record<string, unknown>[]): string | null {
    const created = events.find((e) => e.action === 'page.create');
    if (!created) return null;
    const details = JSON.parse(created.details_json as string) as Record<string, unknown>;
    return typeof details.title === 'string' ? details.title : null;
  }

  /**
   * The field history, derived by comparing consecutive versions. Fields are
   * data (DATA-BACKBONE.md §4), so "who changed the review date, and when" is
   * answerable exactly, which is a question a regulator asks about a policy far
   * more often than "what did paragraph three say".
   */
  private fieldHistory(versions: AttestedVersion[]): FieldChange[] {
    const keys: (keyof PageFields)[] = ['ownerId', 'approverId', 'effectiveDate', 'reviewDate'];
    const out: FieldChange[] = [];
    let previous: PageFields = {};
    for (const version of versions) {
      for (const field of keys) {
        const from = previous[field] ?? null;
        const to = version.fields[field] ?? null;
        if (from === to) continue;
        out.push({
          version: version.number,
          at: version.createdAt,
          field,
          from,
          to,
          byId: version.authorId,
          byName: version.authorName,
        });
      }
      previous = version.fields;
    }
    return out;
  }

  private toAttestedVersion(row: Record<string, unknown>): AttestedVersion {
    const authorId = row.author_id as string;
    return {
      number: Number(row.number),
      title: row.title as string,
      body: row.body as string,
      fields: JSON.parse(row.fields_json as string) as PageFields,
      authorId,
      authorName: this.actorName(authorId),
      note: (row.note as string) ?? null,
      createdAt: row.created_at as string,
    };
  }

  private toAttestedEvent(row: Record<string, unknown>): AttestedAuditEvent {
    const id = Number(row.id);
    const link = linkFor(this.db, id);
    const actorId = row.actor_id as string;
    return {
      id,
      at: row.at as string,
      actorId,
      actorName: this.actorName(actorId),
      actorKind: row.actor_kind as ActorKind,
      action: row.action as string,
      collectionId: (row.collection_id as string) ?? null,
      pageId: (row.page_id as string) ?? null,
      details: JSON.parse(row.details_json as string) as Record<string, unknown>,
      chain: link,
    };
  }

  private nameCache = new Map<string, NamedActor>();

  private named(id: string): NamedActor {
    const cached = this.nameCache.get(id);
    if (cached) return cached;
    let named: NamedActor;
    try {
      const actor = this.host.getActor(id);
      named = { id: actor.id, name: actor.name, kind: actor.kind };
    } catch {
      // An actor id in history whose actor row is gone. History is append-only
      // and names its actor; the actor table is not, so this is possible and
      // must not take the bundle down. The id is still the attribution.
      named = { id, name: `(unknown actor ${id})`, kind: 'person' };
    }
    this.nameCache.set(id, named);
    return named;
  }

  private actorName(id: string): string {
    return this.named(id).name;
  }

  /**
   * Everyone the bundle names, once. Emails are deliberately absent: an
   * attestation is handed to people outside the collection, and `visibleActors`
   * already treats an address as more sensitive than a name.
   */
  private namedActors(ids: (string | null)[]): NamedActor[] {
    const seen = new Set<string>();
    const out: NamedActor[] = [];
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(this.named(id));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

// ---------------------------------------------------------------------------
// The manifest's standing text
//
// Written once, carried in every bundle, and deliberately specific enough to
// act on. "Tamper-evident" in a feature list is marketing; a recipe a reader
// can run is a claim.

export const HOW_TO_VERIFY: string[] = [
  '1. Recompute the content digest. Take this bundle, remove the `manifest` key, serialise what is left with ' +
    'JSON.stringify over keys in the order they appear, and SHA-256 it. It must equal manifest.contentDigest. ' +
    'This detects corruption in transit; it does not detect a forged bundle, because the digest travels inside ' +
    'the file it describes.',
  '2. Recompute each audit event’s chain link. For every entry in `auditEvents` that carries a `chain`, compute ' +
    `${AUDIT_CHAIN_ALGORITHM}(chain.prevHash + JSON.stringify([id, at, actorId, actorKind, action, collectionId, ` +
    'pageId, JSON.stringify(details)])) and compare it with chain.hash. A mismatch means that event’s content ' +
    'differs from what was hashed when it was written.',
  '3. Check the links join up. Within the audit events listed here, an event’s chain.prevHash is the chain.hash ' +
    'of the previous event in the FULL log — not the previous event in this bundle, which is filtered to one ' +
    'page. To check the joins, ask Canon for the full log (`GET /audit`) or run `GET /audit/verify`, which walks ' +
    'the whole chain and names the first break.',
  '4. Compare the head. manifest.auditChain.head is the chain head at the moment this bundle was generated, and ' +
    'manifest.generationEventId is the id of the audit event recording that generation. Ask the live Canon ' +
    '(`GET /audit/verify`) or your own external anchor what the head was at that event id. If they agree, the ' +
    'log up to this bundle has not changed since. If they disagree, one of the two has.',
  '5. Ask Canon to reproduce it. The bundle is derived from immutable history, not stored: request the same ' +
    'page and the same `at` again and the versions, approvals and point-in-time answer must be identical. ' +
    'Anything that differs did not come from the record.',
];

export const BUNDLE_LIMITS: string[] = [
  'This bundle is PERMISSION-FILTERED to the actor who generated it. It contains what that actor may see, which ' +
    'for a page attestation is the page’s own history and the audit events naming it. It is not a claim that ' +
    'nothing else exists.',
  'The audit chain proves the log has not been altered since it was written. It cannot prove that the ' +
    'application wrote a complete log in the first place, and it cannot survive an attacker who can write to ' +
    'Canon’s database and recompute the chain wholesale. Periodic external anchoring of the head hash is what ' +
    'closes that gap; Canon recommends it and does not perform it.',
  'Where `manifest.auditChain.unchainedEventsBefore` is greater than zero, this record was chained from its ' +
    'head forward at some point after it was created. Events before that point carry no link and are not ' +
    'attested to by the chain. Their content is still in the log; it simply is not proven unchanged.',
  'Timestamps are UTC, as recorded by the server that wrote them. A bare date in `at` means the start of that ' +
    'day (00:00:00Z).',
];

/**
 * SHA-256 over the bundle's content, excluding the manifest. `JSON.stringify`
 * with key order as inserted — which is deterministic for a plain object built
 * by this file — so the recipe in `HOW_TO_VERIFY` is one a reader can actually
 * follow with the standard library of any language.
 */
export function contentDigest(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

// ---------------------------------------------------------------------------
// The human rendering
//
// One builder, two renderings. Everything below takes a bundle that is already
// built and permission-filtered and turns it into a document; it reads nothing
// and decides nothing, which is what keeps the two renderings honest about
// being the same artefact.
//
// Self-contained, absolutely: inline CSS, no <script>, no <img>, no <link>, no
// font, no analytics, no network call of any kind. An attestation that fetched
// something would be an attestation whose appearance depends on a server being
// up in five years, and one that could phone home when a regulator opened it.
// It prints cleanly from any browser, which is the whole of Canon's PDF story
// and needs no PDF library to be true.

/** HTML text escaping. Everything from the record goes through this. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2.5rem 1.5rem 4rem; background: #fbfbfa; color: #1c1c1a;
  font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.sheet { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
h2 { font-size: 1.05rem; margin: 2.5rem 0 .75rem; padding-bottom: .35rem; border-bottom: 1px solid #e0dfda;
  text-transform: uppercase; letter-spacing: .08em; color: #56544d; }
h3 { font-size: .95rem; margin: 1.5rem 0 .4rem; }
p { margin: .5rem 0; }
.lede { color: #56544d; margin: 0 0 1.5rem; }
.rule { height: 3px; background: #1c1c1a; margin: 0 0 1.25rem; }
.mark { font-size: .72rem; letter-spacing: .18em; text-transform: uppercase; color: #56544d; margin: 0 0 .5rem; }
table { width: 100%; border-collapse: collapse; margin: .75rem 0; font-size: .88rem; }
th, td { text-align: left; vertical-align: top; padding: .45rem .6rem; border-bottom: 1px solid #e8e7e2; }
th { background: #f2f1ed; font-weight: 600; color: #3d3b36; white-space: nowrap; }
td.num, th.num { text-align: right; white-space: nowrap; }
dl.fields { display: grid; grid-template-columns: 12rem 1fr; gap: .3rem 1rem; margin: .75rem 0; }
dl.fields dt { color: #56544d; }
dl.fields dd { margin: 0; }
code, .hash, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.hash { font-size: .72rem; word-break: break-all; color: #3d3b36; }
pre.body { background: #fff; border: 1px solid #e0dfda; border-left: 3px solid #b9b6ad; padding: .9rem 1rem;
  white-space: pre-wrap; word-wrap: break-word; font-size: .85rem; margin: .5rem 0 1.25rem; }
.badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .72rem; font-weight: 600;
  letter-spacing: .04em; text-transform: uppercase; border: 1px solid #cfcdc5; background: #f2f1ed; color: #3d3b36; }
.badge.canonical { background: #e6f2e9; border-color: #9ec4ac; color: #1f5233; }
.badge.needs_update { background: #fdf1dc; border-color: #ddb96b; color: #6b4a11; }
.badge.archived { background: #eceae5; border-color: #c6c3bb; color: #56544d; }
.badge.in_review { background: #e8eefb; border-color: #a3b8e0; color: #23406e; }
.note { border: 1px solid #e0dfda; background: #fff; padding: 1rem 1.15rem; margin: 1rem 0; }
.note.warn { border-color: #ddb96b; background: #fdf7ea; }
.note.bad { border-color: #d99a92; background: #fbeeec; }
.note h3 { margin-top: 0; }
ol.steps, ul.plain { padding-left: 1.2rem; margin: .5rem 0; }
ol.steps li, ul.plain li { margin: .4rem 0; }
.muted { color: #56544d; }
.small { font-size: .82rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e0dfda; color: #56544d; font-size: .8rem; }
@media print {
  body { background: #fff; padding: 0; font-size: 11pt; }
  h2 { page-break-after: avoid; }
  table, pre.body, .note { page-break-inside: avoid; }
}
`;

function document_(title: string, inner: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><main class="sheet">${inner}</main></body></html>`;
}

function badge(status: string | null): string {
  if (!status) return '';
  return `<span class="badge ${esc(status)}">${esc(status.replace(/_/g, ' '))}</span>`;
}

/**
 * An actor as a reader wants to see one: the name, with the id beside it. The
 * id is never dropped — it is what makes two people called Chris Taylor two
 * different actors in a document a regulator may read years later — and the
 * name is never dropped either, because a page of UUIDs is not an attestation
 * anybody can check against their own records.
 */
function actorCell(id: string | null | undefined, names: Map<string, string>): string {
  if (!id) return '—';
  const name = names.get(id);
  return name ? `${esc(name)} <span class="muted small">${esc(id)}</span>` : esc(id);
}

function fieldsTable(fields: PageFields | null, names: Map<string, string>): string {
  if (!fields) return '<p class="muted">No structured fields.</p>';
  const rows: [string, string][] = [
    ['Owner', actorCell(fields.ownerId, names)],
    ['Approver', actorCell(fields.approverId, names)],
    ['Effective date', esc(fields.effectiveDate ?? '—')],
    ['Review date', esc(fields.reviewDate ?? '—')],
  ];
  return `<dl class="fields">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function nameIndex(actors: NamedActor[]): Map<string, string> {
  return new Map(actors.map((a) => [a.id, a.name]));
}

function chainSection(manifest: AttestationManifest): string {
  const chain = manifest.auditChain;
  const verdict = chain.verifiedAtGeneration;
  const state = verdict.ok
    ? `<div class="note"><h3>Chain verified at generation</h3><p>${esc(verdict.verified)} chained event(s) walked; ` +
      'no break found.</p></div>'
    : `<div class="note bad"><h3>Chain BROKEN at generation</h3><p>${esc(
        verdict.firstBreak?.explanation ?? 'A break was found.',
      )}</p></div>`;
  const unchained =
    chain.unchainedEventsBefore > 0
      ? `<div class="note warn"><h3>Part of this log predates the chain</h3><p>${esc(
          chain.unchainedEventsBefore,
        )} event(s) were written before hash chaining began (the chain covers event ${esc(
          chain.chainedFromEventId,
        )} onward). Those events are still in the log; they are not attested to by the chain, and links computed ` +
        'for them now would prove nothing.</p></div>'
      : '';
  return `
  <h2>The audit chain</h2>
  ${state}
  ${unchained}
  <dl class="fields">
    <dt>Format</dt><dd>${esc(chain.format)} (${esc(chain.algorithm)})</dd>
    <dt>Head event</dt><dd>${chain.head ? esc(chain.head.eventId) : '—'}</dd>
    <dt>Head hash</dt><dd class="hash">${chain.head ? esc(chain.head.hash) : '—'}</dd>
    <dt>Chained from</dt><dd>event ${esc(chain.chainedFromEventId)}</dd>
    <dt>Link recipe</dt><dd class="small">${esc(chain.recipe)}</dd>
  </dl>
  <h3>What a clean chain proves</h3><p class="small">${esc(chain.proves)}</p>
  <h3>What it does not</h3><p class="small">${esc(chain.limits)}</p>`;
}

function manifestSection(manifest: AttestationManifest): string {
  return `
  <h2>Manifest</h2>
  <h3>What this document asserts</h3>
  <ul class="plain small">${manifest.asserts.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
  <dl class="fields">
    <dt>Format</dt><dd>${esc(manifest.format)}</dd>
    <dt>Subject</dt><dd>${esc(manifest.subject.kind)} ${esc(manifest.subject.id)}</dd>
    <dt>Generated at</dt><dd>${esc(manifest.generatedAt)}</dd>
    <dt>Generated by</dt><dd>${esc(manifest.generatedBy.name)} (${esc(manifest.generatedBy.kind)}, ${esc(
      manifest.generatedBy.id,
    )})</dd>
    <dt>Generation event</dt><dd>${manifest.generationEventId === null ? '—' : esc(manifest.generationEventId)}</dd>
    <dt>As at</dt><dd>${manifest.at ? esc(manifest.at) : 'not a point-in-time query'}</dd>
    <dt>Content digest</dt><dd class="hash">sha256:${esc(manifest.contentDigest)}</dd>
  </dl>
  ${chainSection(manifest)}
  <h2>How to verify this without trusting it</h2>
  <ol class="steps small">${manifest.howToVerify.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>
  <h2>What this document does not prove</h2>
  <ul class="plain small">${manifest.limits.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

function asOfSection(asOf: PageAsOf, names: Map<string, string>): string {
  return `
  <h2>As at ${esc(asOf.at)}</h2>
  <div class="note"><p>${esc(asOf.answer)}</p></div>
  <dl class="fields">
    <dt>Existed</dt><dd>${asOf.existed ? 'yes' : 'no'}</dd>
    <dt>Title then</dt><dd>${esc(asOf.title ?? '—')}</dd>
    <dt>Status then</dt><dd>${asOf.status ? badge(asOf.status) : '—'}</dd>
    <dt>Canonical then</dt><dd>${asOf.canonical ? 'yes' : 'no'}</dd>
    <dt>Version then</dt><dd>${asOf.version ? `v${esc(asOf.version.number)} · published ${esc(asOf.version.createdAt)} by ${esc(asOf.version.authorName)}` : 'none'}</dd>
    <dt>Approved by</dt><dd>${
      asOf.approval
        ? `${esc(asOf.approval.approverName)} at ${esc(asOf.approval.at)} (v${esc(asOf.approval.version ?? '—')})`
        : 'no approval covers the version standing at that instant'
    }</dd>
    ${asOf.archivedAt ? `<dt>Archived at</dt><dd>${esc(asOf.archivedAt)}</dd>` : ''}
  </dl>
  ${asOf.fields ? `<h3>Structured fields as they were</h3>${fieldsTable(asOf.fields, names)}` : ''}
  ${
    asOf.version
      ? `<h3>What it said</h3><pre class="body">${esc(asOf.version.body)}</pre>`
      : ''
  }`;
}

/** The page attestation as a self-contained HTML document. */
export function renderPageAttestationHtml(bundle: PageAttestation): string {
  const p = bundle.page;
  const names = nameIndex(bundle.actors);
  const title = `Attestation — ${p.title}`;
  const versions = bundle.versions.length
    ? `<table><thead><tr><th class="num">Version</th><th>Published</th><th>Author</th><th>Title</th><th>Note</th></tr></thead>
       <tbody>${bundle.versions
         .map(
           (v) =>
             `<tr><td class="num">v${esc(v.number)}</td><td>${esc(v.createdAt)}</td><td>${esc(v.authorName)}</td>` +
             `<td>${esc(v.title)}</td><td>${esc(v.note ?? '—')}</td></tr>`,
         )
         .join('')}</tbody></table>`
    : '<p class="muted">This page has never been published.</p>';

  const fieldHistory = bundle.fieldHistory.length
    ? `<table><thead><tr><th class="num">Version</th><th>When</th><th>Field</th><th>From</th><th>To</th><th>By</th></tr></thead>
       <tbody>${bundle.fieldHistory
         .map(
           (f) =>
             `<tr><td class="num">v${esc(f.version)}</td><td>${esc(f.at)}</td><td>${esc(f.field)}</td>` +
             `<td>${esc(f.from ?? '—')}</td><td>${esc(f.to ?? '—')}</td><td>${esc(f.byName)}</td></tr>`,
         )
         .join('')}</tbody></table>`
    : '<p class="muted">No structured field has ever been set on this page.</p>';

  const statusHistory = bundle.statusHistory.length
    ? `<table><thead><tr><th>When</th><th>Became</th><th>By</th><th>Act</th><th>Note</th></tr></thead>
       <tbody>${bundle.statusHistory
         .map(
           (s) =>
             `<tr><td>${esc(s.at)}</td><td>${badge(s.status)}</td><td>${esc(s.actorName)}</td>` +
             `<td><code>${esc(s.action)}</code></td><td>${esc(s.comment ?? (s.version ? `v${s.version}` : '—'))}</td></tr>`,
         )
         .join('')}</tbody></table>`
    : '<p class="muted">No status change is recorded.</p>';

  const approvals = bundle.approvals.length
    ? `<table><thead><tr><th>When</th><th>Approver</th><th class="num">Version</th><th class="num">Audit event</th></tr></thead>
       <tbody>${bundle.approvals
         .map(
           (a) =>
             `<tr><td>${esc(a.at)}</td><td>${esc(a.approverName)}</td><td class="num">v${esc(a.version ?? '—')}</td>` +
             `<td class="num">${esc(a.eventId)}</td></tr>`,
         )
         .join('')}</tbody></table>`
    : '<p class="muted">This page has never been approved: it has never held the Canonical mark.</p>';

  const events = bundle.auditEvents.length
    ? `<table><thead><tr><th class="num">#</th><th>When</th><th>Actor</th><th>Action</th><th>Details</th><th>Chain hash</th></tr></thead>
       <tbody>${bundle.auditEvents
         .map(
           (e) =>
             `<tr><td class="num">${esc(e.id)}</td><td>${esc(e.at)}</td>` +
             `<td>${esc(e.actorName)} <span class="muted small">(${esc(e.actorKind)})</span></td>` +
             `<td><code>${esc(e.action)}</code></td><td class="small">${esc(JSON.stringify(e.details))}</td>` +
             `<td class="hash">${e.chain ? esc(e.chain.hash) : '<span class="muted">unchained</span>'}</td></tr>`,
         )
         .join('')}</tbody></table>`
    : '<p class="muted">No audit event names this page.</p>';

  const bodies = bundle.versions
    .map(
      (v) =>
        `<h3>Version ${esc(v.number)} — ${esc(v.title)} <span class="muted small">${esc(v.createdAt)}, ${esc(
          v.authorName,
        )}</span></h3>${fieldsTable(v.fields, names)}<pre class="body">${esc(v.body)}</pre>`,
    )
    .join('');

  return document_(
    title,
    `
    <p class="mark">Veryl Canon · attestation</p>
    <div class="rule"></div>
    <h1>${esc(p.title)} ${badge(p.status)}</h1>
    <p class="lede">${esc(p.type)} in ${esc(p.collectionName)} · page ${esc(p.id)} · created ${esc(p.createdAt)}</p>
    ${bundle.asOf ? asOfSection(bundle.asOf, names) : ''}
    <h2>The page today</h2>
    <dl class="fields">
      <dt>Collection</dt><dd>${esc(p.collectionName)} (${esc(p.collectionId)})</dd>
      <dt>Type</dt><dd>${esc(p.type)}</dd>
      <dt>Status</dt><dd>${badge(p.status)}</dd>
      <dt>Owner</dt><dd>${actorCell(p.ownerId, names)}</dd>
      <dt>Named approver</dt><dd>${actorCell(p.approverId, names)}</dd>
      <dt>Effective date</dt><dd>${esc(p.effectiveDate ?? '—')}</dd>
      <dt>Review date</dt><dd>${esc(p.reviewDate ?? '—')}</dd>
      <dt>Current version</dt><dd>${p.currentVersion === null ? 'never published' : `v${esc(p.currentVersion)}`}</dd>
    </dl>
    <h2>Published versions</h2>${versions}
    <h2>Approvals</h2>${approvals}
    <h2>Status history</h2>${statusHistory}
    <h2>Field history</h2>${fieldHistory}
    <h2>Audit events naming this page</h2>${events}
    <h2>What each version said</h2>${bodies || '<p class="muted">Nothing has been published.</p>'}
    <h2>People and agents named here</h2>
    <table><thead><tr><th>Name</th><th>Kind</th><th>Id</th></tr></thead><tbody>${bundle.actors
      .map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.kind)}</td><td class="small">${esc(a.id)}</td></tr>`)
      .join('')}</tbody></table>
    ${manifestSection(bundle.manifest)}
    <footer>Generated by Veryl Canon at ${esc(bundle.manifest.generatedAt)} for ${esc(
      bundle.manifest.generatedBy.name,
    )}. This document is self-contained: it references nothing outside itself and makes no network request when
    opened. Print to PDF from any browser.</footer>`,
  );
}

/** The collection register as a self-contained HTML document. */
export function renderCollectionAttestationHtml(bundle: CollectionAttestation): string {
  const rows = (entries: RegisterEntry[]) =>
    entries.length
      ? `<table><thead><tr><th>Page</th><th>Type</th><th>Status</th><th class="num">Version</th><th>Owner</th>
         <th>Approver</th><th>Approved</th><th>Review due</th></tr></thead>
         <tbody>${entries
           .map(
             (e) =>
               `<tr><td>${esc(e.title)}<div class="muted small">${esc(e.pageId)}</div></td><td>${esc(e.type)}</td>` +
               `<td>${badge(e.status)}</td><td class="num">${e.version === null ? '—' : `v${esc(e.version)}`}</td>` +
               `<td>${esc(e.ownerName ?? '—')}</td><td>${esc(e.approverName ?? '—')}</td>` +
               `<td>${esc(e.approvedAt ?? '—')}</td>` +
               `<td>${esc(e.reviewDate ?? '—')}${e.pastReview ? ' <span class="badge needs_update">past</span>' : ''}</td></tr>`,
           )
           .join('')}</tbody></table>`
      : '<p class="muted">None.</p>';

  return document_(
    `Attestation — ${bundle.collection.name} register`,
    `
    <p class="mark">Veryl Canon · register attestation</p>
    <div class="rule"></div>
    <h1>${esc(bundle.collection.name)}</h1>
    <p class="lede">The Canonical record of this collection as at ${esc(bundle.manifest.at ?? '')} · collection ${esc(
      bundle.collection.id,
    )}${bundle.collection.restricted ? ' · restricted' : ''}</p>
    ${bundle.collection.description ? `<p>${esc(bundle.collection.description)}</p>` : ''}
    ${
      bundle.truncated
        ? `<div class="note warn"><h3>Truncated</h3><p>This register lists the first ${esc(
            bundle.truncated.limit,
          )} pages of ${esc(bundle.truncated.total)}. Narrow the collection or read the register in parts; a quietly
          short register is a picture of a record with pages missing and no sign that any are.</p></div>`
        : ''
    }
    <h2>Canonical at that instant (${esc(bundle.register.length)})</h2>${rows(bundle.register)}
    <h2>Not Canonical at that instant (${esc(bundle.notCanonical.length)})</h2>
    <p class="small muted">Listed rather than omitted: "these are the Canonical pages" is only a useful sentence
    alongside "and these were not".</p>
    ${rows(bundle.notCanonical)}
    <h2>People and agents named here</h2>
    <table><thead><tr><th>Name</th><th>Kind</th><th>Id</th></tr></thead><tbody>${bundle.actors
      .map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.kind)}</td><td class="small">${esc(a.id)}</td></tr>`)
      .join('')}</tbody></table>
    ${manifestSection(bundle.manifest)}
    <footer>Generated by Veryl Canon at ${esc(bundle.manifest.generatedAt)} for ${esc(
      bundle.manifest.generatedBy.name,
    )}. Self-contained: no external reference, no network request. Print to PDF from any browser.</footer>`,
  );
}

function stamp(at: string): string {
  return at.replace(/[:.]/g, '-').replace(/Z$/, '');
}

function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'attestation';
}

/** The HTML rendering as a downloadable file response. */
export function attestationHtmlResponse(html: string, name: string, generatedAt: string): RawResponse {
  return new RawResponse(
    200,
    {
      'content-type': 'text/html; charset=utf-8',
      'content-disposition': `attachment; filename="canon-attestation-${slug(name)}-${stamp(generatedAt)}.html"`,
      // Belt and braces on a document that is self-contained by construction:
      // even if a future change let a reference in, the browser would refuse it.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      'x-content-type-options': 'nosniff',
    },
    html,
  );
}
