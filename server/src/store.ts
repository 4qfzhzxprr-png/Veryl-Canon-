import { randomUUID } from 'node:crypto';
import { GapService, type Gap } from './gaps.js';
import type { CitationField } from './answers.js';
import { generatorFromEnv } from './generatorproviders.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  CAN,
  CollectionAbilities,
  cannot,
  collectionName,
  forbiddenRole,
  needsRoleHere,
  notFoundIfStranger,
} from './abilities.js';
import {
  Actor,
  ActorKind,
  AuditEvent,
  CanonError,
  Collection,
  DocType,
  Draft,
  DOC_TYPES,
  Page,
  PageAbilities,
  PageAbility,
  PageFields,
  PageVersion,
  ReviewState,
  revisionUnderReviewStanding,
  Role,
  ROLE_RANK,
  SendBackNotice,
  TYPE_RULES,
} from './model.js';
import {
  countOrgRole,
  explainCollectionAccess,
  GrantExplanation,
  groupsOf,
  isOrgAdministrator,
  isOrgOperator,
  isOrgRole,
  listOrgRoleHolders,
  OrgRole,
  orgRoleDetail,
  orgRoleOf,
  requireOrgRole,
  setHandGrant,
  setHandOrgRole,
} from './orgrole.js';
import { SearchIndex } from './search.js';
import { Comment, CommentAnchor, CommentService, CreatedComment } from './comments.js';
import { Notification, NotificationTransport, Notifier } from './notify.js';
import { EmbeddingProvider, EmbeddingStore } from './embeddings.js';
import { RetrievalCandidate, RetrievalService, RetrieveRequest, parsePageLinks } from './retrieval.js';
import { AnswerResponse, AnswerService, AskRequest } from './answers.js';
import { AUDIT_CSV_MAX_ROWS, AUDIT_CSV_PAGE_ROWS, RawResponse, auditCsvResponse } from './csv.js';
import { ImportInput, ImportRunRecord, ImportService, ImportSummary, ImportUploadInput } from './import.js';
import {
  AccessRequest,
  AccessRequestInput,
  AccessRequestService,
  AccessRequestStatus,
  AskedAccessRequest,
} from './access.js';
import { ConnectorRegistry, defaultConnectorRegistry } from './connectors.js';
import { Source, SourceAbilities, SourceInput, SourceService } from './sources.js';
import { PageReference, ReferenceInput, ReferenceService, ResolvedReference } from './references.js';
import { Divergence, DivergenceFilter, DivergenceService, DivergenceState } from './divergence.js';
import { Proposal, ProposalDecision, ProposalInput, ProposalService, ProposalStatus } from './proposals.js';
import { OwnedConflict, PageRelationView, RelationInput, RelationService } from './relations.js';
import { FreshnessService, FreshnessSweepOptions, FreshnessSweepResult, isIsoDate } from './freshness.js';
import {
  normalizeBasis,
  recordAnchorDate,
  requireBasisForBackdating,
  validateEffectiveDateShape,
} from './effectivedate.js';
import {
  CollectionHealth,
  PageQuery,
  QueryResultPage,
  QueryService,
  SavedQuery,
  WORKFLOW_ACTIONS,
} from './queries.js';
import { QueueService, WorkQueue } from './queue.js';
import { SupersededBy, supersessionMarks } from './supersession.js';
import { GraphService, KnowledgeGraph, RecordGraph, RecordGraphOptions } from './graph.js';
import { AuditChainVerification, verifyAuditChain } from './auditchain.js';
import { refuseSystemActor, SYSTEM_ACTOR_ID, SYSTEM_ACTOR_NAME } from './system.js';
import {
  AttestationService,
  CollectionAttestation,
  PageAsOf,
  PageAttestation,
} from './attestation.js';

export interface TreeNode extends Page {
  children: TreeNode[];
  /**
   * Who `approve` will accept while this page is In Review — the DRAFT's
   * approver, not `Page.approverId`, which is the approver of the published
   * version. Null on every page that is not in review. See `tree`.
   */
  pendingApproverId?: string | null;
  /**
   * What the record says replaces this page, or null. The collection's front
   * page IS its contents table, and a status chip alone told a reader nothing
   * about a page the record had moved on from (REMEDIATION-PLAN.md 1.6).
   * Withheld, never absent, when the replacement is outside what this asker
   * may read — supersession.ts holds the reasoning.
   */
  supersededBy?: SupersededBy | null;
}

/**
 * What can be asked of the audit log. Every one of these is applied in the SQL
 * that generates the rows — there is no such thing here as a filter that is
 * accepted and then not used, which is what USER-TESTING.md T2.2 found and is
 * the reason this interface exists at all rather than being spelled out inline
 * at each of the three call sites (listing, count, export) that must agree.
 */
export interface AuditFilter {
  actorId?: string;
  action?: string;
  collectionId?: string;
  pageId?: string;
  /** Inclusive lower bound on `at`, as ISO-8601 UTC. */
  from?: string;
  /** Inclusive upper bound on `at`, as ISO-8601 UTC. */
  to?: string;
  /** Cursor: only events with an id strictly lower than this. See queryAudit. */
  before?: number;
  limit?: number;
}

/** How big the filtered population is, and what is in it. See auditSummary. */
export interface AuditSummary {
  matching: number;
  actions: { action: string; count: number }[];
}

// One page of the log. The maximum is unchanged — it was never the problem;
// treating it as the end of the log was. The default is what the screen asks
// for, kept at what it has always shown so that the number an auditor sees
// beside "of 1,187" is the number of rows actually in front of them.
export const AUDIT_PAGE_DEFAULT = 200;
export const AUDIT_PAGE_MAX = 1000;

/**
 * The one field in the audit log that is nobody else's business.
 *
 * `auditWhere` decides WHICH events a reader may see, and for an ask that
 * named no collection it already restricts the row to the asker and to
 * operators. But an ask scoped to a collection is an event NAMING that
 * collection, so it reaches every member of it — and the row carries the
 * question verbatim. Measured on a running server: a colleague holding only
 * `view` could read "how do I raise a grievance about my manager", typed by
 * somebody who had every reason to think they were asking a machine.
 *
 * The event itself is genuine audit material and stays whole: that this person
 * asked something of this collection at this instant, and which pages the
 * answer drew on, is exactly what an auditor reconstructing "who looked at the
 * coverage criteria before that denial" needs. It is the SENTENCE that is
 * private, and it is the only part removed.
 *
 * Redaction happens on the way out rather than at write time, because the
 * stored event must stay whole — an operator investigating an incident needs
 * the question, and the hash chain covers the row as written. `[redacted]`
 * rather than a missing key, so a reader can tell a withheld question from an
 * event that never had one, and so nobody reads an absence as "no question was
 * asked".
 */
export function redactAuditDetails(
  action: string,
  details: Record<string, unknown>,
  mayReadPrivateText: boolean,
): Record<string, unknown> {
  if (mayReadPrivateText || action !== 'answer.ask') return details;
  if (typeof details.question !== 'string') return details;
  return { ...details, question: '[redacted: only the person who asked it, and an operator, may read a question]' };
}

function now(): string {
  return new Date().toISOString();
}

export class CanonStore {
  // Derived search index over the published record; rebuildable, never authoritative.
  readonly searchIndex: SearchIndex;
  // The second derived index: chunk embeddings over the same published
  // record (Epic D, M3). Same rules, same rebuildability.
  readonly embeddings: EmbeddingStore;
  // Comments and notifications (Epic C, M2) live in comments.ts and
  // notify.ts; the store carries thin delegates so its surface stays
  // uniform (actorId first). The transport defaults to the dev transport.
  private readonly notifier: Notifier;
  private readonly commentService: CommentService;
  // Retrieval and grounded answers (Epic D, M3) live in retrieval.ts and
  // answers.ts; delegates at the end of this class.
  private readonly retrieval: RetrievalService;
  // The refused-questions loop (gaps.ts): every refusal is a gap report, held
  // until an operator closes it. Owns its own table; asker never stored.
  private readonly gapService: GapService;
  private readonly answers: AnswerService;
  // Federation (DATA-BACKBONE.md §6) lives in sources.ts, connectors.ts and
  // references.ts. The connector registry is a deployment's seam: it defaults
  // to the hermetic static connector so everything runs with no external
  // calls, and a real integration registers itself on it.
  readonly connectors: ConnectorRegistry;
  private readonly sources: SourceService;
  private readonly references: ReferenceService;
  // Contradiction between an authority and a corroborating source
  // (DATA-BACKBONE.md §7) lives in divergence.ts. It is constructed before the
  // reference layer because the reference layer hands it every resolution.
  private readonly divergences: DivergenceService;
  // Agent proposals (FEATURES.md §5, Next tier) live in proposals.ts. A
  // proposal is held apart from the draft on purpose, so it never takes the
  // page lock; see the model note at the top of that file.
  private readonly proposals: ProposalService;
  // Page relations (DATA-BACKBONE.md §7) live in relations.ts: the explicit
  // "conflicts with" / "supersedes" edge between two pages, asserted by a
  // person, that makes contradiction something the map can draw.
  private readonly relations: RelationService;
  // Freshness and structured queries (Next tier) live in freshness.ts and
  // queries.ts; delegates at the end of this class, same as everything above.
  private readonly freshness: FreshnessService;
  private readonly queries: QueryService;
  // The queue (USER-TESTING.md T2.1) lives in queue.ts. It writes no query of
  // its own: it composes the permission-filtered reads above for one actor.
  private readonly queue: QueueService;
  // Asking for access from the refusal that made you want it (access.ts). It
  // resolves a REFUSAL rather than a page id, and it never performs a grant
  // itself — `decideAccessRequest` hands the grant back through `setMember`,
  // so membership keeps one road in.
  private readonly accessRequests: AccessRequestService;

  constructor(
    private readonly db: DatabaseSync,
    transport?: NotificationTransport,
    embeddingProvider?: EmbeddingProvider,
    connectors: ConnectorRegistry = defaultConnectorRegistry(),
  ) {
    this.searchIndex = new SearchIndex(db);
    this.gapService = new GapService(db);
    // Whether a restricted collection's pages may be sent to an egressing
    // embedder is a deployment decision, defaulting to no — the same posture as
    // the answer generator (CANON_GENERATOR_ALLOW_RESTRICTED), for the other
    // egress path. With the on-box default provider it changes nothing.
    const allowRestrictedEmbedEgress = process.env.CANON_EMBEDDINGS_ALLOW_RESTRICTED === 'true';
    this.embeddings = new EmbeddingStore(db, embeddingProvider, allowRestrictedEmbedEgress);
    this.notifier = new Notifier(db, this, transport);
    this.commentService = new CommentService(db, this, this.notifier);
    this.retrieval = new RetrievalService(db, this, this.searchIndex, this.embeddings);
    // The generator is an environment decision, like the embedding provider:
    // extractive unless a deployment selected a model (CANON_GENERATOR). Whether
    // a restricted collection's content may reach an egressing generator is a
    // second environment decision, defaulting to no: a deployment allows it only
    // with a data-processing agreement in place (CANON_GENERATOR_ALLOW_RESTRICTED).
    const allowRestrictedEgress = process.env.CANON_GENERATOR_ALLOW_RESTRICTED === 'true';
    this.answers = new AnswerService(db, this, this.retrieval, generatorFromEnv(), undefined, allowRestrictedEgress);
    this.connectors = connectors;
    this.sources = new SourceService(db, this);
    this.divergences = new DivergenceService(db, this, this.notifier);
    this.references = new ReferenceService(db, this, this.sources, this.connectors, this.divergences);
    this.proposals = new ProposalService(db, this, this.notifier);
    this.relations = new RelationService(db, this);
    this.freshness = new FreshnessService(db, this, this.notifier);
    this.queries = new QueryService(db, this);
    this.queue = new QueueService(db, this);
    this.accessRequests = new AccessRequestService(db);
  }

  // ---- actors ----------------------------------------------------------

  createActor(input: { kind: ActorKind; name: string; email?: string; registryRef?: string }): Actor {
    if (input.kind === 'agent' && !input.registryRef) {
      throw new CanonError('invalid', 'An agent actor requires a Registry reference (Agent Passport)');
    }
    // There is exactly one system actor and openDb writes it (system.ts). A
    // second one would be a second thing calling itself Canon in the audit log,
    // which is the confusion the whole design exists to prevent — and this route
    // is `POST /actors`, which is open to anyone at all under dev auth.
    if (input.kind === 'system') {
      throw new CanonError(
        'invalid',
        `Actors are people and agents. ${SYSTEM_ACTOR_NAME} (${SYSTEM_ACTOR_ID}) is this Canon itself, it already ` +
          'exists, and there is never a second one.',
        { reason: 'system_actor' },
      );
    }
    const actor: Actor = {
      id: randomUUID(),
      kind: input.kind,
      name: input.name,
      email: input.email ?? null,
      registryRef: input.registryRef ?? null,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO actors (id, kind, name, email, registry_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actor.id, actor.kind, actor.name, actor.email, actor.registryRef, actor.createdAt);
    return actor;
  }

  getActor(id: string): Actor {
    const row = this.db.prepare('SELECT * FROM actors WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such actor: ${id}`);
    return {
      id: row.id as string,
      kind: row.kind as ActorKind,
      name: row.name as string,
      email: (row.email as string) ?? null,
      registryRef: (row.registry_ref as string) ?? null,
      createdAt: row.created_at as string,
    };
  }

  /**
   * The directory: people and agents. Canon's own actor is deliberately NOT in
   * it (system.ts). This list answers "who can I name as an owner, an approver,
   * a mention, a member?", and the answer is never Canon — it owns nothing,
   * approves nothing, and cannot be signed in as, so putting it here would offer
   * every one of those pickers a choice that refuses.
   *
   * It stays legible in the audit log without being here: its id is the literal
   * string `system:canon` rather than a UUID, and every event carries
   * `actorKind: 'system'` beside it. A reader with a CSV export and no directory
   * can still tell exactly what acted.
   */
  listActors(): Actor[] {
    const rows = this.db
      .prepare("SELECT id FROM actors WHERE kind != 'system' ORDER BY created_at")
      .all() as { id: string }[];
    return rows.map((r) => this.getActor(r.id));
  }

  // ---- permissions -----------------------------------------------------

  roleOf(actorId: string, collectionId: string): Role | null {
    const row = this.db
      .prepare('SELECT role FROM collection_members WHERE collection_id = ? AND actor_id = ?')
      .get(collectionId, actorId) as { role: Role } | undefined;
    return row?.role ?? null;
  }

  /**
   * `act` names the act where the caller has one worth saying — "Removing a
   * member" — so the sentence a request is refused with is the SAME sentence
   * `collectionAbilities` showed before the button was pressed. Where it is
   * left out the sentence begins "This needs…", which is still the collection,
   * still what they hold, and still who can.
   */
  private requireRole(actorId: string, collectionId: string, needed: Role, act?: string): void {
    const role = this.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      // One sentence, built in abilities.ts, and the same one the screen shows
      // before the click (USER-TESTING.md T4.4, second round). It names the
      // collection, what the caller holds there, and — to somebody who is
      // already a member and could look it up anyway — who does hold the role.
      throw forbiddenRole(this.db, collectionId, role, needed, act);
    }
  }

  // Granting and withdrawing membership is a HAND GRANT (orgrole.ts): it is
  // recorded apart from what a directory group grants, and the row every other
  // query reads — `collection_members` — is recomputed as the stronger of the
  // two. That is what lets a group be revoked without deleting an
  // administrator's deliberate grant, and vice versa (SECURITY.md R10).
  //
  // Who may do it: `admin` on the collection as before, OR the org-level
  // `administrator` role. The second is the break-glass path a Canon needs when
  // a collection's last admin leaves; it is not silent, because the grant it
  // makes is this very audit event with the administrator's name on it.
  // A collection with no administrator cannot be administered back: its members
  // cannot be changed, its restriction cannot be altered, and Canon has no
  // archive or delete for one. A reviewer removed her own membership from a
  // collection she had created four minutes earlier — one unconfirmed click —
  // and stranded it, with a published policy page inside it, recoverable only
  // by hand-crafting a request no screen offers.
  //
  // So the last administrator cannot be taken off, by themselves or by an org
  // administrator: hand the role to somebody else first, which is the act that
  // was missing. Registry already refuses the same thing in the same words.
  private refuseLastAdminLoss(collectionId: string, memberId: string, nextRole: Role | null): void {
    if (nextRole === 'admin') return;
    const current = this.db
      .prepare('SELECT role FROM collection_members WHERE collection_id = ? AND actor_id = ?')
      .get(collectionId, memberId) as { role: Role } | undefined;
    if (current?.role !== 'admin') return;
    const others = this.db
      .prepare("SELECT COUNT(*) AS n FROM collection_members WHERE collection_id = ? AND actor_id != ? AND role = 'admin'")
      .get(collectionId, memberId) as { n: number };
    if (others.n > 0) return;
    throw new CanonError(
      'workflow',
      'This is the only administrator of this collection. Give somebody else the admin role first — a collection with no administrator cannot be administered back.',
      { collectionId, memberId },
    );
  }

  setMember(actorId: string, collectionId: string, memberId: string, role: Role): void {
    this.requirePermissionAdmin(actorId, collectionId, 'Adding a member');
    this.getActor(memberId);
    // The system actor holds no role anywhere and never will (system.ts). Its
    // authority to run maintenance is what it is, not something granted, so
    // there is nothing here for an administrator to widen.
    refuseSystemActor(memberId, 'Granting a collection role');
    if (!ROLE_RANK[role]) throw new CanonError('invalid', `Unknown collection role: ${role}`);
    this.refuseLastAdminLoss(collectionId, memberId, role);
    const { effective, mapped } = setHandGrant(this.db, collectionId, memberId, role);
    this.audit(actorId, 'collection.member_set', {
      collectionId,
      details: {
        memberId,
        role,
        via: 'hand',
        ...(effective !== role ? { effectiveRole: effective } : {}),
        ...(mapped.length ? { alsoGrantedByGroups: mapped } : {}),
      },
    });
  }

  // Withdrawing a hand grant leaves any group-granted access standing — the
  // alternative would be a removal that a re-confirmation quietly undoes sixty
  // seconds later. The caller is told what remains rather than left to discover
  // it: `remaining` names the effective role after the withdrawal and `groups`
  // says which directory groups are holding it up.
  removeMember(
    actorId: string,
    collectionId: string,
    memberId: string,
  ): { removed: boolean; remaining: Role | null; groups: { group: string; role: Role }[] } {
    this.requirePermissionAdmin(actorId, collectionId, 'Removing a member');
    this.refuseLastAdminLoss(collectionId, memberId, null);
    const { effective, mapped } = setHandGrant(this.db, collectionId, memberId, null);
    this.audit(actorId, 'collection.member_removed', {
      collectionId,
      details: {
        memberId,
        ...(effective ? { remainingRole: effective, heldByGroups: mapped } : {}),
      },
    });
    return { removed: effective === null, remaining: effective, groups: mapped };
  }

  // `admin` here, or `administrator` for the whole Canon. Kept in one place so
  // the two membership calls above can never drift apart.
  private requirePermissionAdmin(actorId: string, collectionId: string, act?: string): void {
    if (this.roleOf(actorId, collectionId) === 'admin') return;
    if (isOrgAdministrator(this.db, actorId)) {
      // Existence is still checked, so an org administrator naming a collection
      // that does not exist gets the same not_found anyone else gets.
      const row = this.db.prepare('SELECT id FROM collections WHERE id = ?').get(collectionId) as
        | { id: string }
        | undefined;
      if (!row) throw new CanonError('not_found', `No such collection: ${collectionId}`);
      return;
    }
    this.requireRole(actorId, collectionId, 'admin', act);
  }

  // ---- organisation-level roles (orgrole.ts) ---------------------------
  // The store's thin, actorId-first face onto the org role. The logic and the
  // argument for each role live in orgrole.ts.

  /** This actor's org role. A plain lookup: every actor may know their own, and Canon asks this of itself constantly. */
  orgRoleOf(actorId: string): OrgRole {
    return orgRoleOf(this.db, actorId);
  }

  /** "Is this person an operator of this Canon?" — the question five checks used to ask badly. */
  isOperator(actorId: string): boolean {
    return isOrgOperator(this.db, actorId);
  }

  isAdministrator(actorId: string): boolean {
    return isOrgAdministrator(this.db, actorId);
  }

  /** Grant or withdraw an org role. Administering permissions is the administrator's job. */
  setOrgRole(actorId: string, targetId: string, role: OrgRole): { actorId: string; orgRole: OrgRole } {
    this.getActor(actorId);
    requireOrgRole(this.db, actorId, 'administrator', 'Setting an organisation role');
    const target = this.getActor(targetId);
    refuseSystemActor(targetId, 'Granting an organisation role');
    if (!isOrgRole(role)) throw new CanonError('invalid', `Unknown organisation role: ${String(role)}`);
    // An administrator may stand down, but not the last one: a Canon with no
    // administrator can never have another without the bootstrap, and the
    // bootstrap only fires for somebody signing in.
    if (
      role !== 'administrator' &&
      orgRoleOf(this.db, targetId) === 'administrator' &&
      countOrgRole(this.db, 'administrator') <= 1
    ) {
      throw new CanonError(
        'workflow',
        'This is the last administrator of this Canon; grant somebody else the role before withdrawing it',
        { reason: 'last_administrator' },
      );
    }
    setHandOrgRole(this.db, targetId, role, actorId);
    const now = orgRoleOf(this.db, targetId);
    this.audit(actorId, 'org_role.set', { details: { memberId: target.id, orgRole: role, effective: now } });
    return { actorId: target.id, orgRole: now };
  }

  /**
   * The organisation's FIRST administrator, granted with nobody's permission —
   * because there is nobody to ask (orgrole.ts, "Bootstrap").
   *
   * Safe by construction rather than by trust: it refuses the moment this Canon
   * already holds an administrator, so it is callable exactly once in a
   * record's life and is not a way to escalate. The people-facing door has its
   * own path to the same rule (`CANON_BOOTSTRAP_ADMIN_SUBJECT`, or the first
   * person to sign in); this is the one for a record with no door open yet —
   * the demo seeder, and a dev machine running on `X-Actor-Id`.
   */
  bootstrapAdministrator(actorId: string): OrgRole {
    const actor = this.getActor(actorId);
    refuseSystemActor(actorId, 'Bootstrapping the first administrator');
    if (countOrgRole(this.db, 'administrator') > 0) {
      throw new CanonError(
        'forbidden',
        'This Canon already has an administrator; ask them for the role rather than bootstrapping a second one',
        { reason: 'already_bootstrapped' },
      );
    }
    setHandOrgRole(this.db, actor.id, 'administrator', null);
    this.audit(actor.id, 'org_role.bootstrap', { details: { orgRole: 'administrator', reason: 'first_administrator' } });
    return 'administrator';
  }

  /** Who holds an org role. An operator's question about the shape of the Canon they run. */
  listOrgRoles(actorId: string): { actorId: string; orgRole: OrgRole; hand: OrgRole | null; mapped: OrgRole | null }[] {
    this.getActor(actorId);
    requireOrgRole(this.db, actorId, 'operator', 'Listing organisation roles');
    return listOrgRoleHolders(this.db).map((h) => ({
      actorId: h.actorId,
      orgRole: h.role,
      hand: h.hand,
      mapped: h.mapped,
    }));
  }

  /**
   * "Why does this person have edit here?" — the whole of one person's access,
   * with the origin of every piece of it: the org role and where it came from,
   * the groups their last confirmed ID token carried, and per collection the
   * hand grant, the group grants, and the effective role.
   */
  explainAccess(
    actorId: string,
    targetId: string,
  ): {
    actorId: string;
    orgRole: OrgRole;
    orgRoleHand: OrgRole | null;
    orgRoleMapped: OrgRole | null;
    groups: string[];
    collections: GrantExplanation[];
  } {
    this.getActor(actorId);
    // Your own access is yours to see; anybody else's is an operator's question.
    if (actorId !== targetId) requireOrgRole(this.db, actorId, 'operator', 'Reading another actor’s access');
    const target = this.getActor(targetId);
    const detail = orgRoleDetail(this.db, targetId);
    return {
      actorId: target.id,
      orgRole: detail.role,
      orgRoleHand: detail.hand,
      orgRoleMapped: detail.mapped,
      groups: groupsOf(this.db, targetId),
      collections: explainCollectionAccess(this.db, targetId),
    };
  }

  listMembers(actorId: string, collectionId: string): { actorId: string; role: Role }[] {
    this.getCollection(actorId, collectionId);
    const rows = this.db
      .prepare('SELECT actor_id, role FROM collection_members WHERE collection_id = ? ORDER BY actor_id')
      .all(collectionId) as { actor_id: string; role: Role }[];
    return rows.map((r) => ({ actorId: r.actor_id, role: r.role }));
  }

  // ---- collections -----------------------------------------------------

  createCollection(actorId: string, input: { name: string; description?: string; restricted?: boolean }): Collection {
    this.getActor(actorId);
    if (!input.name?.trim()) throw new CanonError('invalid', 'A collection requires a name');
    const collection: Collection = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description ?? '',
      restricted: input.restricted ?? false,
      createdAt: now(),
      archivedAt: null,
    };
    this.db
      .prepare('INSERT INTO collections (id, name, description, restricted, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(collection.id, collection.name, collection.description, collection.restricted ? 1 : 0, collection.createdAt);
    // The creator's own `admin` is a hand grant like any other, so a group
    // mapping can add to it and neither side can silently erase it.
    setHandGrant(this.db, collection.id, actorId, 'admin');
    this.audit(actorId, 'collection.create', { collectionId: collection.id, details: { name: collection.name } });
    return collection;
  }

  getCollection(actorId: string, id: string): Collection {
    const row = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such collection: ${id}`);
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to this collection is
    // told it does not exist, byte-for-byte as its genuine absence reads, so a
    // real restricted id and an invented one cannot be told apart. A member
    // refused something stronger keeps the informative refusal below.
    notFoundIfStranger(this.roleOf(actorId, id), `No such collection: ${id}`);
    this.requireRole(actorId, id, 'view');
    // How many pages have left the tree. The contents listing is built from the
    // tree and archived pages are not in it, while the attestation register
    // counts every page the collection holds — so the two totals differ by
    // exactly this number, and until it was carried neither screen could say
    // why. Two totals on an examiner's desk that do not tie are a finding
    // whatever the explanation.
    const archivedPages = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM pages WHERE collection_id = ? AND status = 'archived'")
        .get(id) as { n: number }
    ).n;
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      restricted: (row.restricted as number) === 1,
      createdAt: row.created_at as string,
      archivedAt: (row.archived_at as string) ?? null,
      archivedPages,
    };
  }

  listCollections(actorId: string): Collection[] {
    const rows = this.db
      .prepare(
        `SELECT c.id FROM collections c
         JOIN collection_members m ON m.collection_id = c.id
         WHERE m.actor_id = ? AND c.archived_at IS NULL
         ORDER BY c.created_at`,
      )
      .all(actorId) as { id: string }[];
    return rows.map((r) => this.getCollection(actorId, r.id));
  }

  // ---- pages and trees -------------------------------------------------

  /**
   * A NEW PAGE IS OWNED FROM THE MOMENT IT EXISTS.
   *
   * It used to be created with no owner and nothing ever asked for one: nine
   * pages in one seeded collection showed "—" under Owner, and the first thing
   * anybody heard about it was `submitForReview` refusing the page for want of
   * an owner, days later and on a different screen.
   *
   * So `ownerId` is part of creating a page, and it DEFAULTS TO THE CREATOR
   * rather than staying empty. The argument for the default over an empty
   * required field: at the moment a page is created the creator is the only
   * person Canon can honestly name as accountable for it, an empty owner is
   * never a fact about the record but always a gap the product left, and
   * ownership moves constantly — so the field has to be changeable everywhere
   * it already was, and it is: the draft inherits it (see `draftSeed`), the
   * editor's Owner field edits it, and an approver sees a change to it in the
   * diff before granting the Canonical mark. Nothing is locked by this; a page
   * simply stops being born unowned.
   *
   * The client asks anyway — the New page dialog shows Owner, filled in with
   * the creator — because a default nobody is shown is a default nobody
   * corrects.
   *
   * Only for types that HAVE an owner. A Note has no owner field, so a Note
   * given one would carry it until its first publish and silently lose it
   * there, and a value that disappears on its own is worse than none.
   */
  createPage(
    actorId: string,
    input: { collectionId: string; parentId?: string | null; type: DocType; title: string; ownerId?: string | null },
  ): Page {
    this.requireRole(actorId, input.collectionId, 'edit', 'Creating a page');
    if (!DOC_TYPES.includes(input.type)) throw new CanonError('invalid', `Unknown document type: ${input.type}`);
    if (!input.title?.trim()) throw new CanonError('invalid', 'A page requires a title');
    // Absent means the creator. An EXPLICIT null means "no owner named", which
    // is left possible on purpose and is not the same thing: an importer
    // bringing in a corpus whose ownership genuinely is not known must be able
    // to say so, and `hasOwner: false` and the record-health count exist to
    // find exactly those. What is no longer possible is creating an unowned
    // page by not thinking about it.
    const named = input.ownerId === undefined ? actorId : input.ownerId;
    const ownerId = TYPE_RULES[input.type].requiresOwner ? named : null;
    if (ownerId) this.getActor(ownerId); // an owner Canon cannot name is not an owner
    if (input.parentId) {
      const parent = this.pageRow(input.parentId);
      if (parent.collection_id !== input.collectionId) {
        throw new CanonError('invalid', 'Parent page belongs to a different collection');
      }
    }
    const position = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM pages WHERE collection_id = ? AND parent_id IS ?',
        )
        .get(input.collectionId, input.parentId ?? null) as { pos: number }
    ).pos;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pages (id, collection_id, parent_id, position, type, title, status, owner_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(
        id,
        input.collectionId,
        input.parentId ?? null,
        position,
        input.type,
        input.title.trim(),
        ownerId,
        actorId,
        now(),
      );
    // A page is findable by its title from the moment it has one. Search used
    // to be built from published versions alone, so a page that had been
    // written and sent for review — visible in the tree, visible in the audit
    // log — could not be found by its own name (USER-TESTING.md T4.6, bug E).
    // Its BODY still waits for publication; see the note in search.ts.
    this.searchIndex.indexPage(id);
    this.audit(actorId, 'page.create', {
      collectionId: input.collectionId,
      pageId: id,
      details: {
        type: input.type,
        title: input.title.trim(),
        // Named in the log even when it is the default, because "who was this
        // page born accountable to" is exactly the question an auditor asks of
        // a page whose owner has since changed twice.
        ...(ownerId ? { ownerId } : {}),
      },
    });
    return this.getPage(actorId, id);
  }

  private pageRow(id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CanonError('not_found', `No such page: ${id}`);
    return row;
  }

  getPage(actorId: string, id: string, opts: { logView?: boolean } = {}): Page {
    const row = this.pageRow(id);
    const collectionId = row.collection_id as string;
    const restricted =
      (
        this.db.prepare('SELECT restricted FROM collections WHERE id = ?').get(collectionId) as {
          restricted: number;
        }
      ).restricted === 1;
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to this collection —
    // one holding NO role in it — is told the page does not exist, byte-for-byte
    // as its genuine absence reads (`No such page: <id>`, the same 404
    // `/related` and a nonexistent id give), so a hidden page and a missing one
    // cannot be told apart. A member refused a stronger act still meets the
    // informative refusal (via requireRole below).
    const held = this.roleOf(actorId, collectionId);
    if (!held) {
      // A refusal on restricted material is recorded before it is masked. "Who
      // tried and was turned away" is the question an examiner asks first, and
      // the answer must not be lost to the 404 that hides the page's identity.
      if (restricted) this.audit(actorId, 'page.view_refused', { collectionId, pageId: id });
      throw new CanonError('not_found', `No such page: ${id}`);
    }
    try {
      this.requireRole(actorId, collectionId, 'view');
    } catch (err) {
      // A refusal on restricted material is recorded on the same terms as a
      // read of it. "Who tried and was turned away" is the question an examiner
      // asks first, and the log answered it with nothing: an auditor's five
      // refused requests left no trace at all under a page promising a record
      // of every view of restricted material.
      //
      // Scoped to restricted collections exactly as `page.view` is, and for the
      // same reason: everything else would bury the log under the capability
      // probes the UI fires on every sign-in, and a log nobody can read is not
      // evidence either.
      if (restricted) this.audit(actorId, 'page.view_refused', { collectionId, pageId: id });
      throw err;
    }
    const page = this.toPage(row);
    if (opts.logView && restricted) {
      this.audit(actorId, 'page.view', { collectionId, pageId: id });
    }
    return page;
  }

  private toPage(row: Record<string, unknown>): Page {
    // The published aliases ride on the Page like the other fields do. They
    // live in the current version's fields (versioned, reviewed, attributed),
    // so the read joins rather than a column being maintained twice.
    const aliasRow = row.current_version
      ? (this.db
          .prepare(
            `SELECT COALESCE(json_extract(fields_json, '$.aliases'), '[]') AS aliases
             FROM page_versions WHERE page_id = ? AND number = ?`,
          )
          .get(row.id as string, row.current_version as number) as { aliases: string } | undefined)
      : undefined;
    let aliases: string[] = [];
    try {
      const parsed = JSON.parse(aliasRow?.aliases ?? '[]') as unknown;
      if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === 'string');
    } catch {
      aliases = [];
    }
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      parentId: (row.parent_id as string) ?? null,
      position: row.position as number,
      type: row.type as DocType,
      title: row.title as string,
      status: row.status as Page['status'],
      // The page's own standing when a revision is in review over a still-marked
      // version — so a surface shows CANONICAL with the revision noted, not the
      // draft's IN REVIEW in place of it. Derived from the row already in hand.
      pageStanding: revisionUnderReviewStanding(row, now().slice(0, 10)),
      ownerId: (row.owner_id as string) ?? null,
      approverId: (row.approver_id as string) ?? null,
      effectiveDate: (row.effective_date as string) ?? null,
      effectiveDateBasis: (row.effective_date_basis as string) ?? null,
      reviewDate: (row.review_date as string) ?? null,
      currentVersion: (row.current_version as number) ?? null,
      aliases,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
    };
  }

  /**
   * `alsoVisibleTo` is the Knowledge API's second reader (STUDIO-CONTRACT.md
   * §4): a Studio app reads as itself, bounded by the person in front of it.
   * It narrows one thing on this read — whether the page named as a
   * supersession's replacement may be NAMED — because that is the only field
   * here that comes from outside the collection the person was just checked
   * for. Everything else in a tree node is the collection's own.
   */
  tree(actorId: string, collectionId: string, options: { alsoVisibleTo?: string } = {}): TreeNode[] {
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to this collection —
    // one holding NO role in it — is told it does not exist, byte-for-byte as a
    // nonexistent id reads (`No such collection: <id>`, the same 404
    // `getCollection` gives), so a hidden collection and a missing one cannot be
    // told apart. Without this the 403 below named the collection and made this
    // read an existence oracle (P1). A member refused a stronger act still meets
    // the informative refusal via requireRole.
    notFoundIfStranger(this.roleOf(actorId, collectionId), `No such collection: ${collectionId}`);
    this.requireRole(actorId, collectionId, 'view');
    // The pending approver rides along for pages In Review. A compliance
    // director could see his queue but not check it: to prove his sixteen items
    // were all and only his, he would have had to open all twenty-four
    // in-review pages across five collections — the walk the queue exists to
    // end. One column makes the queue cross-footable in thirty seconds.
    //
    // It is read from the DRAFT, like `reviewState` and like `approve` itself.
    // `pages.approver_id` is the approver of the PUBLISHED version and answers
    // a different question; a column built on it would put the T1.3 defect back
    // into a new surface, and look right doing it.
    const rows = this.db
      .prepare(
        `SELECT p.*,
                CASE WHEN p.status = 'in_review'
                     THEN json_extract(d.fields_json, '$.approverId') END AS pending_approver_id
           FROM pages p
           LEFT JOIN drafts d ON d.page_id = p.id
          WHERE p.collection_id = ? AND p.status != 'archived'
          ORDER BY p.position`,
      )
      .all(collectionId) as Record<string, unknown>[];
    // Supersession rides along for the same reason the pending approver does:
    // the alternative is opening every page to find out. One lookup for the
    // whole collection, keyed on ids this asker has just been permitted.
    const superseded = supersessionMarks(
      this.db,
      actorId,
      rows.map((row) => row.id as string),
      { alsoVisibleTo: options.alsoVisibleTo },
    );
    const nodes = new Map<string, TreeNode>();
    for (const row of rows) {
      nodes.set(row.id as string, {
        ...this.toPage(row),
        pendingApproverId: (row.pending_approver_id as string) ?? null,
        supersededBy: superseded.get(row.id as string) ?? null,
        children: [],
      });
    }
    const roots: TreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  movePage(actorId: string, pageId: string, target: { parentId: string | null }): Page {
    const row = this.pageRow(pageId);
    const collectionId = row.collection_id as string;
    this.requireRole(actorId, collectionId, 'edit');
    if (target.parentId) {
      const parent = this.pageRow(target.parentId);
      if (parent.collection_id !== collectionId) {
        throw new CanonError('invalid', 'Pages move within their collection in Core');
      }
      // Walk up from the target parent: moving under a descendant would cycle.
      let cursor: string | null = target.parentId;
      while (cursor) {
        if (cursor === pageId) throw new CanonError('invalid', 'Cannot move a page under its own descendant');
        const up = this.db.prepare('SELECT parent_id FROM pages WHERE id = ?').get(cursor) as {
          parent_id: string | null;
        };
        cursor = up.parent_id;
      }
    }
    const position = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM pages WHERE collection_id = ? AND parent_id IS ?',
        )
        .get(collectionId, target.parentId ?? null) as { pos: number }
    ).pos;
    this.db
      .prepare('UPDATE pages SET parent_id = ?, position = ? WHERE id = ?')
      .run(target.parentId ?? null, position, pageId);
    this.audit(actorId, 'page.move', { collectionId, pageId, details: { parentId: target.parentId } });
    return this.getPage(actorId, pageId);
  }

  archivePage(actorId: string, pageId: string): Page {
    const row = this.pageRow(pageId);
    this.requireRole(actorId, row.collection_id as string, 'edit', 'Archiving');
    this.db.prepare("UPDATE pages SET status = 'archived' WHERE id = ?").run(pageId);
    this.searchIndex.indexPage(pageId); // archived pages leave search
    this.embeddings.indexPage(pageId); // and leave the vector index too
    this.audit(actorId, 'page.archive', { collectionId: row.collection_id as string, pageId });
    return this.getPage(actorId, pageId);
  }

  // ---- drafts and the page lock ---------------------------------------

  /**
   * The guard every road into a page's draft shares: the edit role, a page
   * that is editable at all, and the one-editor lock. One place, because a
   * probe that answered "yes, you may edit" while the edit itself said
   * "locked" would be the lock working only against people who type fast.
   */
  private editablePage(actorId: string, pageId: string): { page: Page; existing?: Record<string, unknown> } {
    const row = this.pageRow(pageId);
    this.requireRole(actorId, row.collection_id as string, 'edit', 'Editing');
    const page = this.toPage(row);
    if (page.status === 'archived') throw new CanonError('workflow', 'Archived pages are read-only');
    if (page.status === 'in_review') {
      throw new CanonError('workflow', 'This page is in review; wait for the approver or send it back');
    }
    const existing = this.draftRow(pageId);
    if (existing && existing.editor_id !== actorId) {
      const editor = this.getActor(existing.editor_id as string);
      throw new CanonError('locked', `This page is being edited by ${editor.name}`, {
        editorId: editor.id,
        editorName: editor.name,
      });
    }
    return { page, existing };
  }

  /**
   * What the editor shows on open, and NOTHING else: the held draft where the
   * asker holds one, otherwise the seed the first save would start from —
   * without creating either. Opening an editor used to BE an edit (an empty
   * patch through `editDraft`), which meant walking in the door took the page
   * lock, put an untyped "draft" in the queue and a `draft.start` in the
   * audit log, for a person who might close the tab without typing (fourth
   * round, finding 4). The lock survives — it is simply taken by the first
   * call that actually changes something, which still goes through
   * `editDraft` — and this probe refuses in exactly the same cases an edit
   * would, so "you may look" never contradicts "you may not type".
   *
   * The alias-collision warnings ride along for the same reason they ride on
   * a save: a collision that predates this editing session belongs on screen
   * from the first paint, not after the first keystroke.
   */
  openDraft(actorId: string, pageId: string): Draft & { warnings: string[]; linkWarnings: string[] } {
    const { page, existing } = this.editablePage(actorId, pageId);
    const base = existing ?? this.draftSeed(page);
    const fields = JSON.parse(base.fields_json as string) as PageFields;
    return {
      pageId,
      title: base.title as string,
      body: base.body as string,
      fields,
      editorId: (existing?.editor_id as string) ?? actorId,
      baseVersion: existing ? ((existing.base_version as number) ?? null) : page.currentVersion,
      updatedAt: (existing?.updated_at as string) ?? now(),
      warnings: this.aliasCollisionWarnings(pageId, page.collectionId, fields.aliases ?? []),
      // Its own field, not folded into `warnings`: the two say different things
      // to different parts of the screen — a collision is about the names
      // field, this is about the body — and a caller that merges them ends up
      // appending one's explanation to the other's sentence. On screen from the
      // first paint, for the same reason the collisions are: it is a fact about
      // text that is already written, not about the next keystroke.
      linkWarnings: this.linkAudienceWarnings(actorId, page.collectionId, base.body as string),
    };
  }

  editDraft(
    actorId: string,
    pageId: string,
    input: { title?: string; body?: string; fields?: PageFields },
  ): Draft & { warnings: string[]; linkWarnings: string[] } {
    const { page, existing } = this.editablePage(actorId, pageId);

    // The patch is validated against what the draft already carries, not on its
    // own: "is this effective date backdated" is a question about the page, and
    // "is this a CHANGE to the effective date" is a question about the patch.
    const base = existing ?? this.draftSeed(page);
    const inherited = JSON.parse(base.fields_json as string) as PageFields;
    const patch = input.fields ? this.validateFieldShape(page, input.fields, inherited) : null;
    const fields: PageFields = { ...inherited, ...(patch ?? {}) };
    const title = input.title?.trim() || (base.title as string);
    const body = input.body ?? (base.body as string);
    const at = now();

    if (existing) {
      this.db
        .prepare('UPDATE drafts SET title = ?, body = ?, fields_json = ?, updated_at = ? WHERE page_id = ?')
        .run(title, body, JSON.stringify(fields), at, pageId);
    } else {
      this.db
        .prepare(
          `INSERT INTO drafts (page_id, title, body, fields_json, editor_id, base_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(pageId, title, body, JSON.stringify(fields), actorId, page.currentVersion, at);
      this.audit(actorId, 'draft.start', { collectionId: page.collectionId, pageId });
    }
    // Advisory, never a refusal: a name another page in this collection
    // already carries steers search and Ask toward both pages, which is
    // sometimes exactly what is meant (two pages legitimately share
    // vocabulary) and sometimes a quiet mis-steering nobody chose. Only the
    // editor knows which, so the save stands and the sentence travels with it.
    return {
      ...this.getDraft(actorId, pageId)!,
      warnings: this.aliasCollisionWarnings(pageId, page.collectionId, fields.aliases ?? []),
      linkWarnings: this.linkAudienceWarnings(actorId, page.collectionId, body),
    };
  }

  /**
   * WHO THIS PAGE'S OWN READERS ARE, FOR EACH PAGE ITS BODY LINKS TO.
   *
   * Policy question 3, Canon's half. `withheldLinks` (75c5166) closed the
   * reader's half: a link to a page the READER cannot open loses its label, so
   * a title is not handed over in the body of a page somebody was granted. What
   * that deliberately could not reach is prose — a sentence that merely NAMES a
   * restricted page is indistinguishable from any other sentence, and no
   * permission check will ever find it.
   *
   * The only person who can judge the sentence is the person writing it, and
   * nothing told them. So this is what the author is told: for every page this
   * body links to, how many of the people who can read THIS page cannot open
   * that one. It is prose around the link — "as set out in the workforce plan"
   * — that gives the game away, and an author who knows the link is dark to
   * eleven of their fourteen readers can write the sentence differently, or
   * not write it.
   *
   * A WARNING, NEVER A BLOCK. A cross-collection link is a normal, useful thing
   * — the record hangs together — and refusing one would make Canon a product
   * that stops people writing down what is true. The author is told a fact and
   * decides.
   *
   * TWO THINGS IT DELIBERATELY DOES NOT DO.
   *
   *   * It says nothing about a link whose target the AUTHOR cannot open.
   *     Reporting "this link goes somewhere your readers cannot follow" about a
   *     page the author was themselves refused would confirm that the page
   *     exists — the same oracle the disclosure rule refuses everywhere else.
   *     Those links are already handled at the far end, for the reader.
   *   * It does not gate on a majority. "Most readers cannot see it" was the
   *     shape of the finding, and a threshold would turn a fact into a verdict
   *     with an invented number in it: 6 of 14 is worth knowing and 7 of 14 is
   *     not, for no reason anybody could defend. The count is stated and the
   *     lines are ordered worst-first, so the author reads the serious ones
   *     first and judges the rest.
   */
  linkAudienceWarnings(actorId: string, collectionId: string, body: string): string[] {
    const linked = parsePageLinks(body ?? '');
    if (!linked.length) return [];
    const readers = (
      this.db.prepare('SELECT actor_id FROM collection_members WHERE collection_id = ?').all(collectionId) as {
        actor_id: string;
      }[]
    ).map((r) => r.actor_id);
    if (!readers.length) return [];

    // One line per target COLLECTION, not per link: three links into the same
    // restricted collection are one thing to know, said once.
    const blockedByCollection = new Map<string, { name: string; blocked: number; links: number }>();
    for (const id of linked) {
      const row = this.db
        .prepare(
          `SELECT p.collection_id AS collection_id, c.name AS name
           FROM pages p JOIN collections c ON c.id = p.collection_id WHERE p.id = ?`,
        )
        .get(id) as { collection_id: string; name: string } | undefined;
      // An id naming no page is text, exactly as retrieval treats it.
      if (!row) continue;
      if (row.collection_id === collectionId) continue;
      // The author's own sight of the target is the gate — see above.
      if (!this.roleOf(actorId, row.collection_id)) continue;
      const blocked = readers.filter((reader) => !this.roleOf(reader, row.collection_id)).length;
      if (blocked === 0) continue;
      const seen = blockedByCollection.get(row.collection_id);
      if (seen) seen.links += 1;
      else blockedByCollection.set(row.collection_id, { name: row.name, blocked, links: 1 });
    }

    return [...blockedByCollection.values()]
      .sort((a, b) => b.blocked - a.blocked || a.name.localeCompare(b.name))
      .map(
        (c) =>
          `${c.links === 1 ? 'A link' : `${c.links} links`} in this page ` +
          `${c.links === 1 ? 'goes' : 'go'} to “${c.name}”, which ${c.blocked} of the ${readers.length} ` +
          `${readers.length === 1 ? 'person' : 'people'} who can read this page cannot open. They will see ` +
          'that a link is there and not what it points at — so the sentence around it has to stand on its own.',
      );
  }

  /**
   * The alias names this draft carries that another non-archived page in the
   * same collection ALREADY carries — compared case-insensitively, because
   * that is how validateFieldShape deduplicates and how the search index
   * matches. The other page's aliases are read from its current published
   * version's fields, the same place search.ts indexPage reads them: what is
   * live is what can collide, and a name still sitting in somebody's draft
   * steers nothing yet.
   */
  private aliasCollisionWarnings(pageId: string, collectionId: string, aliases: readonly string[]): string[] {
    if (aliases.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT p.title AS title, COALESCE(json_extract(v.fields_json, '$.aliases'), '[]') AS aliases
           FROM pages p
           JOIN page_versions v ON v.page_id = p.id AND v.number = p.current_version
          WHERE p.collection_id = ? AND p.id != ? AND p.status != 'archived'`,
      )
      .all(collectionId, pageId) as { title: string; aliases: string }[];
    const carriers = new Map<string, string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.aliases) as unknown;
        if (!Array.isArray(parsed)) continue;
        for (const alias of parsed) {
          if (typeof alias === 'string' && !carriers.has(alias.toLowerCase())) {
            carriers.set(alias.toLowerCase(), row.title);
          }
        }
      } catch {
        // An unreadable list carries no names to collide with.
      }
    }
    const warnings: string[] = [];
    for (const alias of aliases) {
      const other = carriers.get(alias.toLowerCase());
      if (other !== undefined) {
        warnings.push(`The name “${alias}” is also carried by “${other}” in this collection.`);
      }
    }
    return warnings;
  }

  private draftRow(pageId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM drafts WHERE page_id = ?').get(pageId) as
      | Record<string, unknown>
      | undefined;
  }

  private draftSeed(page: Page): Record<string, unknown> {
    const current = page.currentVersion
      ? (this.db
          .prepare('SELECT title, body, fields_json FROM page_versions WHERE page_id = ? AND number = ?')
          .get(page.id, page.currentVersion) as Record<string, unknown>)
      : undefined;
    return {
      title: current?.title ?? page.title,
      body: current?.body ?? '',
      fields_json:
        current?.fields_json ??
        JSON.stringify({
          ownerId: page.ownerId,
          approverId: page.approverId,
          effectiveDate: page.effectiveDate,
          effectiveDateBasis: page.effectiveDateBasis,
          reviewDate: page.reviewDate,
        } satisfies PageFields),
    };
  }

  getDraft(actorId: string, pageId: string): Draft | null {
    const row = this.pageRow(pageId);
    // A stranger to the collection is told the page does not exist (abilities.ts);
    // a member who holds `view` but not `edit` still gets the informative refusal.
    notFoundIfStranger(this.roleOf(actorId, row.collection_id as string), `No such page: ${pageId}`);
    this.requireRole(actorId, row.collection_id as string, 'edit');
    const draft = this.draftRow(pageId);
    if (!draft) return null;
    return {
      pageId,
      title: draft.title as string,
      body: draft.body as string,
      fields: JSON.parse(draft.fields_json as string) as PageFields,
      editorId: draft.editor_id as string,
      baseVersion: (draft.base_version as number) ?? null,
      updatedAt: draft.updated_at as string,
    };
  }

  discardDraft(actorId: string, pageId: string): void {
    const row = this.pageRow(pageId);
    this.requireRole(actorId, row.collection_id as string, 'edit');
    const draft = this.draftRow(pageId);
    if (!draft) return;
    if (draft.editor_id !== actorId) {
      throw new CanonError('locked', 'Only the current editor can discard this draft');
    }
    if ((row.status as string) === 'in_review') {
      throw new CanonError('workflow', 'This page is in review; send it back before discarding the draft');
    }
    this.db.prepare('DELETE FROM drafts WHERE page_id = ?').run(pageId);
    this.audit(actorId, 'draft.discard', { collectionId: row.collection_id as string, pageId });
  }

  /**
   * The shape rules for one patch of structured fields, returned normalised.
   *
   * `patch` is what this edit is setting; `inherited` is what the draft already
   * carried. The distinction is load-bearing for the effective date: the shape
   * of a value is checked whenever it arrives, but the DECLARATION a backdated
   * date requires is asked only of the person who sets one. A page that already
   * carries a backdated date from before the rule existed goes on publishing —
   * see effectivedate.ts, and `canonicalWithoutEffectiveDate` /
   * `backdatedWithoutBasis` in queries.ts, which is where those pages surface
   * instead of being silently blessed.
   */
  // Bounds on the alias list — see validateFieldShape. Sized for names, not prose.
  static readonly MAX_ALIASES = 20;

  private validateFieldShape(page: Page, patch: PageFields, inherited: PageFields): PageFields {
    const type = page.type;
    const rules = TYPE_RULES[type];
    const out: PageFields = { ...patch };

    if (patch.effectiveDate) {
      if (!rules.allowsEffectiveDate) {
        throw new CanonError('invalid', `Effective date applies only to Policy pages, not ${type}`);
      }
      // USER-TESTING.md T1.5: this field was never checked at all. `isIsoDate`
      // had existed since freshness shipped and was called on the review date
      // beside it and never on this one.
      validateEffectiveDateShape(patch.effectiveDate);
    }
    if (patch.effectiveDateBasis !== undefined) {
      // Normalised BEFORE the type is consulted: a client that sends the whole
      // field set — the UI does, and so does an accepted proposal — sends
      // `effectiveDateBasis: null` on a Note, and refusing that would be
      // refusing the absence of a value. Only a basis with something in it is a
      // claim a Note has no standing to make.
      const basis = normalizeBasis(patch.effectiveDateBasis);
      if (basis && !rules.allowsEffectiveDate) {
        throw new CanonError('invalid', `A ${type} carries no effective date, so there is no basis for one to state`);
      }
      out.effectiveDateBasis = basis;
    }

    const nextDate = 'effectiveDate' in patch ? (patch.effectiveDate ?? null) : (inherited.effectiveDate ?? null);
    const nextBasis =
      out.effectiveDateBasis !== undefined ? (out.effectiveDateBasis ?? null) : (inherited.effectiveDateBasis ?? null);
    if (!nextDate && nextBasis) {
      // A basis explains a date. If this patch supplies one with no date to
      // explain, that is a mistake worth naming; if the patch CLEARS the date,
      // the basis it explained goes with it rather than being left dangling.
      if (out.effectiveDateBasis) {
        throw new CanonError(
          'invalid',
          '"Where the effective date comes from" explains an effective date; this page states none',
        );
      }
      out.effectiveDateBasis = null;
    }
    requireBasisForBackdating({
      next: nextDate,
      previous: inherited.effectiveDate ?? null,
      basis: nextBasis,
      anchor: recordAnchorDate(page.createdAt, this.firstPublishedAt(page.id)),
    });

    // Freshness: the review date is a typed field, so its shape is checked the
    // same way the effective date's is, and which types may carry one is
    // TYPE_RULES' answer rather than a test written at this call site.
    if (patch.reviewDate) {
      if (!rules.allowsReviewDate) {
        throw new CanonError('invalid', `A ${type} carries no review date; it never holds the Canonical mark`);
      }
      if (!isIsoDate(patch.reviewDate)) {
        throw new CanonError('invalid', `A review date is an ISO date (YYYY-MM-DD), not '${patch.reviewDate}'`);
      }
    }
    for (const key of ['ownerId', 'approverId'] as const) {
      const value = patch[key];
      if (value) this.getActor(value);
    }

    // Aliases: other names for what the page is, normalised here so that what
    // is stored is what was meant — trimmed, deduplicated without regard to
    // case, and bounded, because an unbounded list of free text on every page
    // is a search index someone can quietly stuff.
    if (patch.aliases !== undefined) {
      if (!Array.isArray(patch.aliases) || patch.aliases.some((a) => typeof a !== 'string')) {
        throw new CanonError('invalid', 'aliases must be a list of short names');
      }
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of patch.aliases) {
        const alias = raw.trim().replace(/\s+/g, ' ');
        if (!alias) continue;
        if (alias.length > 64) {
          throw new CanonError('invalid', `An alias is a short name; '${alias.slice(0, 40)}…' is ${alias.length} characters`);
        }
        const key = alias.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        cleaned.push(alias);
      }
      if (cleaned.length > CanonStore.MAX_ALIASES) {
        throw new CanonError('invalid', `A page carries at most ${CanonStore.MAX_ALIASES} aliases`);
      }
      out.aliases = cleaned;
    }
    return out;
  }

  /** When this page's first version was published, or null if none ever was. */
  private firstPublishedAt(pageId: string): string | null {
    const row = this.db
      .prepare('SELECT created_at FROM page_versions WHERE page_id = ? ORDER BY number LIMIT 1')
      .get(pageId) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  private validateReadyToPublish(type: DocType, fields: PageFields): void {
    const rules = TYPE_RULES[type];
    if (rules.requiresOwner && !fields.ownerId) {
      throw new CanonError('workflow', `A ${type} requires an owner before it can publish`);
    }
    if (rules.requiresApprover && !fields.approverId) {
      throw new CanonError('workflow', `A ${type} requires a named approver before it can publish`);
    }
    if (rules.requiresReviewDate && !fields.reviewDate) {
      throw new CanonError('workflow', `A ${type} requires a review date before it can publish`);
    }
    // USER-TESTING.md T1.5. The field a regulator asks about first, required of
    // the type a regulator asks it about — see the note in TYPE_RULES for why
    // Policy and nothing else, and why this is a rule about the act of
    // publishing rather than about rows already in the record.
    if (rules.requiresEffectiveDate && !fields.effectiveDate) {
      throw new CanonError(
        'workflow',
        `A ${type} requires an effective date before it can publish: the day what it says began to apply. ` +
          'If it predates this record, fill in "Where the effective date comes from" as well.',
      );
    }
  }

  // ---- publishing and history ------------------------------------------

  publish(actorId: string, pageId: string, input: { note?: string } = {}): Page & { linkWarnings?: string[] } {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'edit');
    if (page.status === 'archived') throw new CanonError('workflow', 'Archived pages are read-only');
    if (page.status === 'in_review') {
      throw new CanonError('workflow', 'This page is in review; only the approver can accept it');
    }
    const draft = this.draftRow(pageId);
    if (!draft) throw new CanonError('workflow', 'Nothing to publish: there is no draft');
    if (draft.editor_id !== actorId) {
      throw new CanonError('locked', 'Only the current editor can publish this draft');
    }
    const fields = JSON.parse(draft.fields_json as string) as PageFields;
    this.validateReadyToPublish(page.type, fields);
    // Computed BEFORE the draft is cleared, because writeVersion clears it —
    // and carried out on the response, because publishing is the moment the
    // text stops being the author's alone. Additive: the page is exactly the
    // page every existing caller reads. See linkAudienceWarnings.
    const linkWarnings = this.linkAudienceWarnings(actorId, page.collectionId, draft.body as string);
    const published = this.writeVersion(actorId, page, {
      title: draft.title as string,
      body: draft.body as string,
      fields,
      note: input.note ?? null,
    });
    return linkWarnings.length ? { ...published, linkWarnings } : published;
  }

  // Creates the next immutable version, updates the current pointer and the
  // page's structured fields, clears the draft, and settles status: a Note
  // stays a working note; a reviewed type returns to Draft because the
  // Canonical mark applies to reviewed content, not to whatever came after.
  //
  // `opts.authorId` separates who WROTE a version from who ACTED to create it,
  // for the two places they differ: an accepted proposal, authored by the agent
  // that proposed it while the acting actor is the person who accepted it
  // (proposals.ts), and an approval, authored by the drafter while the acting
  // actor is the approver granting the mark. On publish they are necessarily
  // the same — only the current editor may publish — which is why it defaults
  // to actorId.
  private writeVersion(
    actorId: string,
    page: Page,
    content: { title: string; body: string; fields: PageFields; note: string | null },
    opts: { toStatus?: Page['status']; authorId?: string } = {},
  ): Page {
    const next =
      (
        this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM page_versions WHERE page_id = ?').get(page.id) as {
          n: number;
        }
      ).n;
    const at = now();
    this.db
      .prepare(
        `INSERT INTO page_versions (page_id, number, title, body, fields_json, author_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        page.id,
        next,
        content.title,
        content.body,
        JSON.stringify(content.fields),
        opts.authorId ?? actorId,
        content.note,
        at,
      );
    this.db
      .prepare(
        `UPDATE pages SET title = ?, owner_id = ?, approver_id = ?, effective_date = ?,
         effective_date_basis = ?, review_date = ?,
         current_version = ?, status = ? WHERE id = ?`,
      )
      .run(
        content.title,
        content.fields.ownerId ?? null,
        content.fields.approverId ?? null,
        content.fields.effectiveDate ?? null,
        // The basis follows the date it explains: clearing one clears the other,
        // so the record never carries an explanation of nothing.
        content.fields.effectiveDate ? (content.fields.effectiveDateBasis ?? null) : null,
        content.fields.reviewDate ?? null,
        next,
        opts.toStatus ?? 'draft',
        page.id,
      );
    this.db.prepare('DELETE FROM drafts WHERE page_id = ?').run(page.id);
    this.searchIndex.indexPage(page.id); // publish, approve, and restore all land here
    this.embeddings.indexPage(page.id); // the same hook for the derived vector index
    this.audit(actorId, 'page.publish', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: {
        version: next,
        status: opts.toStatus ?? 'draft',
        // Named only when it differs from the actor, so the log answers "who
        // wrote this" as well as "who published it".
        ...(opts.authorId && opts.authorId !== actorId ? { authorId: opts.authorId } : {}),
      },
    });
    return this.getPage(actorId, page.id);
  }

  listVersions(actorId: string, pageId: string): PageVersion[] {
    const row = this.pageRow(pageId);
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger to the collection is
    // told the page does not exist, byte-for-byte as a nonexistent id reads,
    // rather than a 403 naming the collection that holds it (P1). A member
    // refused a stronger act still meets the informative refusal below.
    notFoundIfStranger(this.roleOf(actorId, row.collection_id as string), `No such page: ${pageId}`);
    this.requireRole(actorId, row.collection_id as string, 'view');
    const rows = this.db
      .prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY number')
      .all(pageId) as Record<string, unknown>[];
    return rows.map((r) => this.toVersion(r));
  }

  getVersion(actorId: string, pageId: string, number: number): PageVersion {
    const row = this.pageRow(pageId);
    // EXISTENCE, NEVER IDENTITY (abilities.ts): a stranger reads the page as
    // nonexistent, not as a 403 naming its collection (P1). Kept identical to
    // listVersions so /pages/:id/versions/:n cannot be an existence oracle
    // either.
    notFoundIfStranger(this.roleOf(actorId, row.collection_id as string), `No such page: ${pageId}`);
    this.requireRole(actorId, row.collection_id as string, 'view');
    const v = this.db
      .prepare('SELECT * FROM page_versions WHERE page_id = ? AND number = ?')
      .get(pageId, number) as Record<string, unknown> | undefined;
    if (!v) throw new CanonError('not_found', `No version ${number} of page ${pageId}`);
    return this.toVersion(v);
  }

  /**
   * The last version of this page to RECEIVE the Canonical mark, or null when
   * no version ever has.
   *
   * Not the same question as "the current published version", and the
   * difference is the whole of USER-TESTING.md's third-round finding 1:
   * publishing moves the current pointer with no approver's name on the move,
   * so on a page that was edited, published and re-drafted, `current` already
   * contains changes nobody reviewed. A review surface that takes it as the
   * baseline folds those changes into the background and asks the approver to
   * certify content it never showed them.
   *
   * Read from the log's `page.approve` events — the same rows the
   * attestation's Approvals section is built from — rather than from a column,
   * because granting the mark is an act, and the log is where acts live; a
   * second copy on `pages` would be a second answer that can disagree with the
   * record of the granting. Readable with `view`, like the history it is one
   * row of.
   */
  lastCanonicalVersion(actorId: string, pageId: string): PageVersion | null {
    const row = this.pageRow(pageId);
    this.requireRole(actorId, row.collection_id as string, 'view');
    const approved = this.db
      .prepare(
        `SELECT json_extract(details_json, '$.version') AS version FROM audit_events
          WHERE page_id = ? AND action = 'page.approve'
            AND json_extract(details_json, '$.version') IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(pageId) as { version: number } | undefined;
    if (!approved) return null;
    return this.getVersion(actorId, pageId, Number(approved.version));
  }

  private toVersion(row: Record<string, unknown>): PageVersion {
    return {
      pageId: row.page_id as string,
      number: row.number as number,
      title: row.title as string,
      body: row.body as string,
      fields: JSON.parse(row.fields_json as string) as PageFields,
      authorId: row.author_id as string,
      note: (row.note as string) ?? null,
      createdAt: row.created_at as string,
    };
  }

  // Restore never rewrites history: it publishes the old content as a new version.
  restore(actorId: string, pageId: string, number: number): Page {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'edit');
    if (page.status === 'archived') throw new CanonError('workflow', 'Archived pages are read-only');
    if (page.status === 'in_review') throw new CanonError('workflow', 'This page is in review');
    const draft = this.draftRow(pageId);
    if (draft && draft.editor_id !== actorId) {
      const editor = this.getActor(draft.editor_id as string);
      throw new CanonError('locked', `This page is being edited by ${editor.name}`);
    }
    const source = this.getVersion(actorId, pageId, number);
    const restored = this.writeVersion(actorId, page, {
      title: source.title,
      body: source.body,
      fields: source.fields,
      note: `Restored from version ${number}`,
    });
    this.audit(actorId, 'page.restore', {
      collectionId: page.collectionId,
      pageId,
      details: { from: number, to: restored.currentVersion },
    });
    return restored;
  }

  // ---- review workflow -------------------------------------------------
  //
  // THE INVARIANT THIS SECTION KEEPS: the approver NAMED on any surface is the
  // approver `approve` will accept, and nobody else.
  //
  // It has to be written down because a page's approver lives in two places
  // and they can legitimately differ. `pages.approver_id` is the approver of
  // the PUBLISHED version — history, written by `writeVersion`. The draft's
  // `fields_json` carries the approver being PROPOSED. Submit a draft that
  // changes the approver and, until it is approved, those are two different
  // people and both rows are true, about different questions.
  //
  // `approve` below enforces the DRAFT's, and must. Approval publishes that
  // draft, so the approver named in the version it writes is the person who
  // granted the mark; enforcing the page row instead would publish a version
  // naming one person, approved by another — precisely the thing an auditor
  // samples this control to catch. `Notifier.reviewRequested` reads the
  // draft's too, which is why the right person was always TOLD to review while
  // the screen named somebody else (USER-TESTING.md T1.3).
  //
  // So the defect was never in the enforcement, it was in the naming, and the
  // remedy is one answer rather than two: `reviewState` is what every surface
  // asks while a page is in review. A screen that names an approver from
  // anywhere else is a bug, and a new naming surface that reads
  // `page.approverId` mid-review is reintroducing this one.

  /**
   * What is pending on a page In Review: the fields the draft carries, the
   * approver `approve` will accept, and who submitted it.
   *
   * Null for a page that is not in review — nothing is pending, and the page's
   * own fields are the published truth, which is the answer every other screen
   * already shows.
   *
   * Readable with `view`, not `edit`. These four structured fields say who is
   * accountable for a page and who is being asked to accept it; anyone who can
   * read the page will see them the moment it publishes, and withholding them
   * for the days it sits in review is what produced a banner naming nobody on
   * a page that had never published (T1.3, second half). The draft's BODY is
   * unchanged and stays behind `edit`: this returns fields, never prose.
   */
  reviewState(actorId: string, pageId: string): ReviewState | null {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'view');
    if (page.status !== 'in_review') return null;
    const draft = this.draftRow(pageId);
    if (!draft) return null;
    const fields = JSON.parse(draft.fields_json as string) as PageFields;
    const namesApprover = TYPE_RULES[page.type].requiresApprover;
    const submitted = this.lastSubmission(pageId);
    const role = this.roleOf(actorId, page.collectionId);
    return {
      pageId,
      fields,
      approverId: namesApprover ? fields.approverId ?? null : null,
      namesApprover,
      editorId: draft.editor_id as string,
      submittedById: submitted?.actorId ?? null,
      submittedAt: submitted?.at ?? null,
      canWithdraw:
        submitted !== null &&
        submitted.actorId === actorId &&
        role !== null &&
        ROLE_RANK[role] >= ROLE_RANK.edit,
    };
  }

  // Who submitted this page for review, from the event that recorded it. The
  // audit log is the record of who did what, so it is also the right place to
  // ask "whose submission is this?" — storing a second copy of the answer on
  // `pages` would be a copy that can disagree with the log.
  private lastSubmission(pageId: string): { actorId: string; at: string } | null {
    const row = this.db
      .prepare("SELECT actor_id, at FROM audit_events WHERE page_id = ? AND action = 'page.submit' ORDER BY id DESC LIMIT 1")
      .get(pageId) as { actor_id: string; at: string } | undefined;
    return row ? { actorId: row.actor_id, at: row.at } : null;
  }

  submitForReview(actorId: string, pageId: string): Page & { linkWarnings?: string[] } {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'edit');
    if (!TYPE_RULES[page.type].reviewed) {
      throw new CanonError('workflow', 'Notes publish directly and never carry the Canonical mark');
    }
    // Draft, Needs Update — or Canonical, with the draft going to review
    // directly. The freshness case is unchanged: a page the sweep flipped
    // comes back to Canonical through THIS workflow and no other
    // (FEATURES.md §3), because a "re-certify" path would be a second meaning
    // for the mark. The Canonical case is the third round's finding 8: the
    // only road for an edit to a marked page used to be publish-first, which
    // hands the mark back and takes the official answer offline for the whole
    // review — the publish dialog itself argued against the one road that
    // existed. Submitting the draft keeps the approved version serving while
    // the approver decides; nothing a reader sees changes until the mark is
    // granted again, which is the promise review makes everywhere else.
    if (page.status === 'in_review') {
      throw new CanonError('workflow', 'This page is already in review; the approver accepts it or sends it back');
    }
    if (page.status === 'archived') {
      throw new CanonError('workflow', 'Archived pages are read-only');
    }
    const draft = this.draftRow(pageId);
    if (!draft) throw new CanonError('workflow', 'Nothing to review: there is no draft');
    const fields = JSON.parse(draft.fields_json as string) as PageFields;
    this.validateReadyToPublish(page.type, fields);
    if (TYPE_RULES[page.type].requiresApprover && fields.approverId === actorId) {
      throw new CanonError('workflow', 'The approver cannot submit their own draft for review');
    }
    this.db.prepare("UPDATE pages SET status = 'in_review' WHERE id = ?").run(pageId);
    this.audit(actorId, 'page.submit', { collectionId: page.collectionId, pageId });
    this.notifier.reviewRequested(actorId, pageId);
    // The other moment the author is committing the text: from here it is an
    // approver's to accept, and the person who can still change a sentence is
    // about to stop being the person holding it.
    const linkWarnings = this.linkAudienceWarnings(actorId, page.collectionId, draft.body as string);
    const submitted = this.getPage(actorId, pageId);
    return linkWarnings.length ? { ...submitted, linkWarnings } : submitted;
  }

  /**
   * The named approver accepts the draft, and the page becomes Canonical.
   *
   * WHY THE NOTE IS STILL OPTIONAL HERE WHILE THE SEND-BACK COMMENT IS NOT.
   *
   * A compliance director called that asymmetry backwards (USER-TESTING.md
   * T4.3): you must type something to refuse and nothing to accept. It is the
   * right observation and it has the wrong remedy, so the asymmetry stays and
   * is argued for rather than left looking like an oversight.
   *
   * The send-back comment is required because WITHOUT IT THE ACT IS
   * UNPERFORMABLE BY ITS RECIPIENT. "Not yet" tells an author nothing they can
   * do; the whole content of a refusal is what has to change. Nothing else in
   * the record carries it — there is no diff to read, because the draft did not
   * publish and history did not move.
   *
   * Approval is the opposite: the act writes its own record. `writeVersion`
   * publishes the exact text approved, stamped with this actor's name and this
   * instant, and the diff against what it replaced is on the page and in
   * history for as long as the record exists. An auditor sampling this control
   * asks "what did she approve, and was she the person named to approve it" —
   * and both answers are in the record already, with or without a sentence.
   *
   * A REQUIRED FIELD WOULD MAKE THAT WORSE, NOT BETTER. Forty policies a
   * quarter through a mandatory box produces forty rows reading "ok", and a
   * column of "ok" is not an absence of evidence, it is fake evidence: it looks
   * like forty considered approvals. Everything Canon knows about that column
   * would be a lie it made somebody tell.
   *
   * What the complaint is actually about is that approval was CHEAP — the
   * approver could not see what they were accepting (T4.2). That is fixed where
   * it belongs, by putting the diff in front of the decision instead of behind
   * it, and the note stays what it is: optional, and worth reading when
   * somebody chose to write one, which is a property a required field destroys.
   */
  approve(actorId: string, pageId: string, input: { note?: string } = {}): Page {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'approve');
    if (page.status !== 'in_review') {
      throw new CanonError('workflow', `Only a page In Review can be approved (status: ${page.status})`);
    }
    const draft = this.draftRow(pageId);
    if (!draft) throw new CanonError('workflow', 'The draft under review is missing');
    const fields = JSON.parse(draft.fields_json as string) as PageFields;
    const rules = TYPE_RULES[page.type];
    // The DRAFT's approver, per the invariant at the top of this section — and
    // the same one `reviewState` publishes to every screen, so the green
    // Approve button and this refusal can never disagree about who is meant.
    if (rules.requiresApprover && fields.approverId !== actorId) {
      throw new CanonError('forbidden', 'Only the named approver can grant the Canonical mark', {
        approverId: fields.approverId ?? null,
      });
    }
    // A Plan names no approver; any holder of the approve role accepts it —
    // and that is where separation of duties had a hole in it.
    //
    // `submitForReview` refuses "the approver cannot submit their own draft",
    // but only where the TYPE names an approver. On a Plan it names none, so a
    // person holding `approve` could submit their own draft and then grant it
    // the Canonical mark themselves. The concentration-of-duty report found it
    // while measuring: one mark, self-approved, `refusedAtSubmission: false`.
    //
    // The check belongs here rather than at submission, because the rule is
    // about who GRANTS THE MARK, not about who typed. Enforced at submission it
    // would still be avoidable — submit under one identity, approve under
    // another — and it would refuse the ordinary case where somebody tidies up
    // a colleague's draft and puts it forward for a third person to approve.
    // Here it holds for every type, named approver or not.
    //
    // Read from the audit log rather than from a column, because "who put this
    // forward" is an act rather than a field, and the log is where acts live.
    const submitted = this.lastSubmission(pageId);
    if (submitted && submitted.actorId === actorId) {
      throw new CanonError('forbidden', 'The person who submitted a page for review cannot grant it the Canonical mark', {
        submittedBy: submitted.actorId,
      });
    }
    const approved = this.writeVersion(
      actorId,
      page,
      {
        title: draft.title as string,
        body: draft.body as string,
        fields,
        note: input.note ?? 'Approved as Canonical',
      },
      // The approver grants the mark; they did not write the words. Without
      // this the version — and with it Version History, the compare header and
      // the attestation bundle — named the approver as author of text the
      // drafter wrote. Those are the three artifacts Canon produces to PROVE
      // separation of duties, and they were the ones asserting it had not
      // happened, while the audit log recorded the split correctly all along.
      { toStatus: 'canonical', authorId: draft.editor_id as string },
    );
    // The mark follows the act that grants it. `marked_version` is the log's
    // `page.approve` answer denormalised onto the row so retrieval can ask
    // "is what this page is serving reviewed content?" per candidate, in SQL
    // (retrieval.ts, ANSWERABLE_STATUSES). Written here and nowhere else,
    // because approval is the only act that grants the mark — publish moves
    // `current_version` and deliberately leaves this behind, which is exactly
    // how an unreviewed publish stops being answerable.
    this.db.prepare('UPDATE pages SET marked_version = ? WHERE id = ?').run(approved.currentVersion, page.id);
    this.audit(actorId, 'page.approve', {
      collectionId: page.collectionId,
      pageId,
      details: { version: approved.currentVersion },
    });
    this.notifier.draftApproved(actorId, pageId, draft.editor_id as string);
    return approved;
  }

  /**
   * Where a page lands when it leaves review WITHOUT the mark being granted —
   * a send-back, or a withdrawal.
   *
   * `draft` was the only answer while the only road into review started from
   * Draft. Now that a Canonical page submits its draft directly (finding 8),
   * the answer has to be derived: such a page is still serving the version its
   * approver accepted — the submission changed nothing a reader sees, and a
   * refusal of the DRAFT must not either. Dropping it to Draft would revoke a
   * mark no approver revoked, and would punish the owner for taking the review
   * road, which is the incentive the road exists to remove.
   *
   * Derived rather than remembered: serving the marked version IS what the
   * mark's statuses mean, so the row already holds the answer and a stored
   * "status before review" would be a copy that can disagree with it. A review
   * date already past lands on `needs_update` — the sweep's verdict stands;
   * leaving review is not a fresh grant of anything.
   */
  private statusAfterReview(row: Record<string, unknown>): Page['status'] {
    const current = (row.current_version as number) ?? null;
    const marked = (row.marked_version as number) ?? null;
    if (current === null || marked === null || current !== marked) return 'draft';
    const reviewDate = (row.review_date as string) ?? null;
    return reviewDate && reviewDate < now().slice(0, 10) ? 'needs_update' : 'canonical';
  }

  /**
   * An approver refuses a draft and says why (USER-TESTING.md T4.3).
   *
   * WHERE THE REASON GOES, AND WHY IT GOES THERE THREE TIMES.
   *
   * It used to go to one place: the `details` of an audit event, which is a
   * screen an author has no reason to open and, when they do open it, is a
   * thousand rows of everybody's work. The modal promised "Your comment goes to
   * the author", the toast said "Sent back with your comment", the comments
   * panel said "No comments yet", and the author got back a Draft with no
   * banner, no reason and no name on it. Every one of those sentences was true
   * of the outbox and none of them was true of the page.
   *
   * So the reason is now:
   *
   *   1. A COMMENT ON THE PAGE, filed here, authored by the approver, through
   *      the ordinary comment path — so it is in the panel that promised it, it
   *      can be replied to and resolved like any other, and it is still there
   *      in six months when somebody asks why the page took three rounds.
   *      Filed FIRST, before the status moves: a send-back whose reason could
   *      not be recorded is not a send-back this record wants to have happened.
   *   2. THE AUDIT EVENT, unchanged, plus the id of that comment — so the log
   *      and the panel are demonstrably the same refusal rather than two.
   *   3. THE OUTBOX, unchanged: the author is told, carrying the text.
   *
   * And the banner the author actually sees is none of these — it is `sentBack`
   * below, which reads 2 back out. There is no fourth copy and no flag on
   * `pages`; a column saying "this was sent back" would be a second answer that
   * can disagree with the log about the first.
   */
  sendBack(actorId: string, pageId: string, input: { comment: string }): Page {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'approve');
    if (page.status !== 'in_review') {
      throw new CanonError('workflow', `Only a page In Review can be sent back (status: ${page.status})`);
    }
    const comment = input.comment?.trim();
    if (!comment) {
      throw new CanonError('invalid', 'Sending a draft back requires a comment for the author');
    }
    // `approve` outranks `comment`, so an approver always holds the role this
    // needs; it is called rather than inlined so a send-back comment is a
    // comment in every respect — attributed, audited, mentionable, resolvable.
    const filed = this.commentService.create(actorId, pageId, { body: comment });
    this.db.prepare('UPDATE pages SET status = ? WHERE id = ?').run(this.statusAfterReview(row), pageId);
    this.audit(actorId, 'page.send_back', {
      collectionId: page.collectionId,
      pageId,
      details: { comment, commentId: filed.id },
    });
    this.notifier.draftSentBack(actorId, pageId, comment);
    return this.getPage(actorId, pageId);
  }

  /**
   * The send-back that is still standing on this page, or null.
   *
   * "Still standing" is not a state anybody sets. It is read from the log, in
   * the same sentence the queue's "Sent back to you" strand reads: the last act
   * in the review workflow on this page was a send-back, and the page is back
   * out of review — a Draft, or the standing a Canonical page kept through its
   * refused submission (statusAfterReview). A resubmission, a withdrawal or a
   * direct publish displaces it, and the banner disappears without anybody
   * having to remember to clear a flag — which is exactly why there is no flag
   * to clear.
   *
   * Readable with `view`, like `reviewState` and for the same reason: why a
   * page is sitting in Draft rather than carrying the mark is a fact about the
   * page, not a private message. The reason's text is in a comment on that same
   * page anyway, and comments are readable with `view`.
   */
  sentBack(actorId: string, pageId: string): SendBackNotice | null {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'view');
    if (page.status === 'in_review' || page.status === 'archived') return null;
    const last = this.db
      .prepare(
        `SELECT actor_id, at, action, details_json FROM audit_events
          WHERE page_id = ? AND action IN (${WORKFLOW_ACTIONS.map(() => '?').join(', ')})
          ORDER BY id DESC LIMIT 1`,
      )
      .get(pageId, ...WORKFLOW_ACTIONS) as
      | { actor_id: string; at: string; action: string; details_json: string }
      | undefined;
    if (!last || last.action !== 'page.send_back') return null;
    const details = JSON.parse(last.details_json) as { comment?: unknown; commentId?: unknown };
    const reason = typeof details.comment === 'string' ? details.comment : '';
    return {
      byId: last.actor_id,
      at: last.at,
      reason,
      // Null for a send-back written before this filed a comment. The banner
      // still reads, because the text is on the event either way.
      commentId: typeof details.commentId === 'string' ? details.commentId : null,
    };
  }

  /**
   * The author takes their own submission back (USER-TESTING.md T4.5).
   *
   * Hitting Submit a paragraph too early is the ordinary mistake, and before
   * this there was no way out of it: the editor is locked while a page is in
   * review, publish is refused, approve is refused, and Send back belongs to
   * the approver. The author's only recourse was to interrupt the person they
   * had just interrupted and ask to be interrupted back. The page sat In
   * Review with nobody's name on it in the meantime.
   *
   * IT LOOSENS NOTHING. Withdrawal is not approval and not publication: the
   * page leaves review exactly where a send-back leaves it (statusAfterReview
   * — a Draft, or the standing it entered review still serving), and the road
   * to Canonical is still submit-then-approve with `approve` enforcing the
   * named approver. Two limits keep it there:
   *
   *   * ONLY THE ACTOR WHO SUBMITTED IT may withdraw it — read from the audit
   *     event that recorded the submission, not from the page lock, because
   *     the person who submitted is the person whose act is being undone. Not
   *     the owner, not an approver, not everyone else holding `edit`. An
   *     approver who wants a page out of review already has Send back, which
   *     costs them a comment to the author and puts their refusal on the
   *     record; withdrawal must not become a quiet way around that. Nor does
   *     it help an approver reach their own draft: submitting one is refused
   *     upstream in `submitForReview` and nothing here touches that.
   *   * ONLY WHILE IT IS STILL IN REVIEW, which is the same sentence as
   *     "before anybody has acted on it": approval and send-back both leave
   *     the status somewhere other than `in_review`, so a decision that has
   *     been taken cannot be untaken by this route.
   *
   * And it is audited like every other transition — `page.withdraw`, which
   * attestation.ts's status machine reads — so "who pulled this back, and
   * when" is answerable from the record rather than inferred from a gap.
   */
  withdrawFromReview(actorId: string, pageId: string, input: { reason?: string } = {}): Page {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'edit');
    if (page.status !== 'in_review') {
      throw new CanonError('workflow', `Only a page In Review can be withdrawn (status: ${page.status})`);
    }
    const submitted = this.lastSubmission(pageId);
    if (!submitted) {
      // No submission on the record to undo. Refusing is the honest answer:
      // the alternative would be letting anybody with `edit` pull a page out
      // of review on the strength of a missing event.
      throw new CanonError('workflow', 'No submission is on the record for this page; an approver sends it back');
    }
    if (submitted.actorId !== actorId) {
      const by = this.getActor(submitted.actorId);
      throw new CanonError(
        'forbidden',
        `Only ${by.name}, who submitted this page for review, can withdraw it; an approver sends it back with a comment`,
        { submittedById: by.id },
      );
    }
    const reason = input.reason?.trim() || null;
    this.db.prepare('UPDATE pages SET status = ? WHERE id = ?').run(this.statusAfterReview(row), pageId);
    this.audit(actorId, 'page.withdraw', {
      collectionId: page.collectionId,
      pageId,
      details: reason ? { reason } : {},
    });
    // Whoever was asked to review is told it is no longer waiting on them. A
    // review request that silently stops being a review request is how a queue
    // fills with work nobody needs to do.
    this.notifier.reviewWithdrawn(actorId, pageId, reason);
    return this.getPage(actorId, pageId);
  }

  /**
   * WHAT THIS ACTOR MAY DO TO THIS PAGE, AND WHERE THEY MAY NOT, WHO CAN.
   *
   * USER-TESTING.md T4.4: "Every action is offered then refused: New page,
   * Comment, Approve, Send back, and a red Delete on a live data source — all
   * shown, all 403 at the last click." An auditor hit the same wall from the
   * other side, shown a green Approve button the server would refuse her.
   *
   * The server always knew. Every one of those refusals is a rule written a few
   * lines above this one, and the screen simply never asked. So it can ask:
   * this is `reviewState.canWithdraw` generalised to every act the page view
   * offers, with the sentence attached.
   *
   * IT IS A MIRROR, NEVER A GATE. That is the whole discipline of this method
   * and it cuts in one direction only:
   *
   *   * Nothing here is a permission check. Every act still asks its own
   *     question at the moment it is performed, against the record as it is
   *     then, and a caller who reaches `approve` directly is refused by
   *     `approve` exactly as before. A UI that trusted this and a server that
   *     stopped checking would be a product with no access control and a
   *     tooltip.
   *   * `can: true` where the act would refuse is a BUG — that is the defect
   *     being fixed, restated. `can: false` where the act would succeed is
   *     merely unhelpful. So where a rule is fiddly this CALLS the rule rather
   *     than restating it: `whyNotReady` runs `validateReadyToPublish` and
   *     hands back its own sentence, so the day a new field becomes required
   *     before publishing, this screen says so without being edited.
   *
   * Naming names gives nothing away: this needs `view`, and anyone with `view`
   * can already read the collection's membership and every comment on the page.
   */
  pageAbilities(actorId: string, pageId: string): PageAbilities {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'view');
    const role = this.roleOf(actorId, page.collectionId);
    const rank = role ? ROLE_RANK[role] : 0;
    const rules = TYPE_RULES[page.type];
    const draft = this.draftRow(pageId);
    const fields = draft ? (JSON.parse(draft.fields_json as string) as PageFields) : null;
    const archived = page.status === 'archived';

    const here = { id: page.collectionId, name: collectionName(this.db, page.collectionId) };
    const yes: PageAbility = CAN;
    const no = cannot;
    const holds = (needed: Role): boolean => rank >= ROLE_RANK[needed];
    // One vocabulary, built in abilities.ts and shared with the Members screen,
    // the source register and the relation dialog: what the act needs, what the
    // caller holds, and who can. It names the collection rather than saying
    // "this collection", so the same sentence can be repeated on a screen about
    // a DIFFERENT collection — which is exactly what a cross-collection
    // conflict needs (see `assertRelation` below).
    const needsRole = (act: string, needed: Role): PageAbility => needsRoleHere(this.db, here, role, act, needed);
    const readOnly = 'This page is archived and read-only. Its history is preserved.';

    // Each block below mirrors one method above, in that method's own order —
    // the order decides which sentence a person is given when two rules refuse
    // them at once, and the useful one is always the first the server hits.

    // editDraft
    let edit: PageAbility;
    if (!holds('edit')) edit = needsRole('Editing', 'edit');
    else if (archived) edit = no(readOnly);
    else if (page.status === 'in_review') {
      edit = no('This page is in review; it unlocks when the approver accepts it or sends it back.');
    } else if (draft && (draft.editor_id as string) !== actorId) {
      edit = no(
        `${this.getActor(draft.editor_id as string).name} is editing this page; ` +
          'Canon keeps drafts to one editor at a time.',
      );
    } else edit = yes;

    // CommentService.create
    let comment: PageAbility;
    if (!holds('comment')) comment = needsRole('Commenting', 'comment');
    else if (archived) comment = no(readOnly);
    else comment = yes;

    // submitForReview
    let submit: PageAbility;
    if (!holds('edit')) submit = needsRole('Submitting for review', 'edit');
    else if (!rules.reviewed) {
      submit = no('A Note publishes directly and never carries the Canonical mark, so it never goes to review.');
    } else if (archived) submit = no(readOnly);
    else if (page.status === 'in_review') {
      // The one status that cannot submit. Canonical is no longer on this
      // list: its draft goes to review directly, keeping the marked version
      // serving while the approver decides (finding 8) — so the mirror stopped
      // saying otherwise the same day the gate did.
      submit = no('This page is already in review; the approver accepts it or sends it back.');
    } else if (!draft || !fields) submit = no('There is nothing to review: this page has no draft.');
    else {
      const unready = this.whyNotReady(page.type, fields);
      if (unready) submit = no(unready);
      else if (rules.requiresApprover && fields.approverId === actorId) {
        submit = no(
          'You are the named approver on this draft, and an approver cannot submit their own draft for review.',
        );
      } else submit = yes;
    }

    // The submission is read once, above the two blocks that need it: `approve`
    // mirrors separation of duties from it and `withdraw` mirrors whose act is
    // being undone, and both must read the same event or the two buttons could
    // disagree about who put this page forward.
    const submitted = page.status === 'in_review' ? this.lastSubmission(pageId) : null;

    // approve — the draft's approver, per the invariant at the top of this
    // section. This answer and that refusal read the same row.
    let approve: PageAbility;
    if (!holds('approve')) approve = needsRole('Approving', 'approve');
    else if (page.status !== 'in_review') approve = no('Only a page In Review can be approved.');
    else if (!draft || !fields) approve = no('The draft under review is missing.');
    else if (rules.requiresApprover && fields.approverId !== actorId) {
      approve = fields.approverId
        ? no(`Only ${this.getActor(fields.approverId).name}, the named approver on this draft, can approve it.`)
        : no('This draft names no approver, so there is nobody the server would accept; it has to name one.');
    } else if (submitted && submitted.actorId === actorId) {
      // Separation of duties, in the mirror as well as the gate. `approve`
      // reads the submission from the log and refuses the submitter; a
      // projection that stops one clause short shows that person a live
      // Approve button whose press dies in silence — which is the exact
      // defect this method exists to end, on the one rule where the refusal
      // most needs explaining.
      approve = no('The person who submitted a page for review cannot grant it the Canonical mark.');
    } else approve = yes;

    // sendBack
    let sendBack: PageAbility;
    if (!holds('approve')) sendBack = needsRole('Sending a draft back', 'approve');
    else if (page.status !== 'in_review') sendBack = no('Only a page In Review can be sent back.');
    else sendBack = yes;

    // withdrawFromReview
    let withdraw: PageAbility;
    if (!holds('edit')) withdraw = needsRole('Withdrawing a submission', 'edit');
    else if (page.status !== 'in_review') withdraw = no('Only a page In Review can be withdrawn.');
    else if (!submitted) {
      withdraw = no('No submission is on the record for this page; an approver sends it back.');
    } else if (submitted.actorId !== actorId) {
      withdraw = no(
        `Only ${this.getActor(submitted.actorId).name}, who submitted this page for review, can withdraw it; ` +
          'an approver sends it back with a comment.',
      );
    } else withdraw = yes;

    // archivePage, which asks for `edit` and asks nothing else — an archived
    // page can be archived again and the record is unmoved by it. Reported as
    // it is rather than as it might read better: this projection's one promise
    // is that it says what the server would do.
    const archive: PageAbility = holds('edit') ? yes : needsRole('Archiving', 'edit');

    // RelationService.assert, for THIS end of the relation. A relation needs
    // `edit` on both pages' collections, and this half is the one a page view
    // can answer on its own — the other end is a different collection, whose
    // sentence comes from `collectionAbilities` for that collection and reads
    // the same because it is built by the same function.
    let assertRelation: PageAbility;
    const actorKind = this.getActor(actorId).kind;
    if (actorKind === 'agent') {
      assertRelation = no(
        'An agent may not assert a relation. It raises a proposal carrying its reasoning, and a person ' +
          'settles it — asserting that two pages contradict each other is a person’s act.',
      );
    } else if (!holds('edit')) assertRelation = needsRole('Asserting a relation', 'edit');
    else if (archived) assertRelation = no(readOnly);
    else assertRelation = yes;

    return { role, edit, comment, submit, approve, sendBack, withdraw, archive, assertRelation };
  }

  /**
   * WHAT THIS ACTOR MAY DO TO THIS COLLECTION, in `pageAbilities`' own voice
   * and under its one rule: it MIRRORS the checks and never makes one.
   *
   * The Members screen was the last one in the product still offering a control
   * it would refuse — a fully enabled Remove beside every colleague's name and
   * a live Add member form, for somebody holding `edit`, answered with a
   * three-second toast in the far corner. It is also the screen where a wrong
   * click would be most alarming. This is what it now draws its buttons from.
   *
   * Reading it needs `view`, like the membership table it describes.
   */
  collectionAbilities(actorId: string, collectionId: string): CollectionAbilities {
    this.getCollection(actorId, collectionId); // existence, and `view`
    const here = { id: collectionId, name: collectionName(this.db, collectionId) };
    const role = this.roleOf(actorId, collectionId);
    const rank = role ? ROLE_RANK[role] : 0;
    const holds = (needed: Role): boolean => rank >= ROLE_RANK[needed];

    // `requirePermissionAdmin`: `admin` here, OR the org-level `administrator`,
    // which is the break-glass path for a collection whose last admin left. The
    // mirror has to carry it or an administrator would be told they cannot do
    // a thing the server accepts from them.
    const orgAdmin = isOrgAdministrator(this.db, actorId);
    const membership = (act: string): PageAbility =>
      holds('admin') || orgAdmin ? CAN : needsRoleHere(this.db, here, role, act, 'admin');

    return {
      collectionId,
      role,
      createPage: holds('edit') ? CAN : needsRoleHere(this.db, here, role, 'Creating a page', 'edit'),
      addMember: membership('Adding a member'),
      removeMember: membership('Removing a member'),
      assertRelation: holds('edit') ? CAN : needsRoleHere(this.db, here, role, 'Asserting a relation', 'edit'),
      // `ImportService.requireRole(collectionId, 'admin')`, mirrored — and
      // deliberately NOT `membership`, which the org-level `administrator` also
      // satisfies. An import is refused by `roleOf` alone, so an org
      // administrator holding no role here is refused it, and an ability that
      // said otherwise would offer a form the server throws away a corpus over.
      runImport: holds('admin') ? CAN : needsRoleHere(this.db, here, role, 'Importing', 'admin'),
    };
  }

  /** Why this draft could not publish as it stands, in `validateReadyToPublish`'s own words. */
  private whyNotReady(type: DocType, fields: PageFields): string | null {
    try {
      this.validateReadyToPublish(type, fields);
      return null;
    } catch (err) {
      return err instanceof CanonError ? err.message : 'This draft is not ready to publish.';
    }
  }


  // ---- audit -----------------------------------------------------------

  private audit(
    actorId: string,
    action: string,
    ctx: { collectionId?: string; pageId?: string; details?: Record<string, unknown> } = {},
  ): void {
    const actor = this.getActor(actorId);
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        actorId,
        actor.kind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }

  /**
   * The rows one page of the audit log, newest first.
   *
   * PAGING: A CURSOR, NOT AN OFFSET, AND WHY
   *
   * An external auditor found that the log capped at 1,000 rows with no offset,
   * cursor or page parameter, so a record of 1,187 events had 187 of them
   * unreachable by any documented route (USER-TESTING.md T2.2). The cap is
   * still here — it is a sane page size — but it is no longer the horizon.
   *
   * `before` is an event id, and a page is "the newest N events with an id
   * lower than this one". An OFFSET would have been fewer lines and it would
   * have been wrong, for a reason particular to this table:
   *
   *   * `audit_events` is APPEND-ONLY and ordered by a monotonic AUTOINCREMENT
   *     id, and this query reads it NEWEST FIRST. So every event written while
   *     somebody is paging is inserted at the *front* of the result — the end
   *     they have already read. With OFFSET, each new event shifts the whole
   *     tail down by one, and the reader silently sees a row they have already
   *     seen and never sees the one it displaced. On a log that is being
   *     appended to by the very people whose acts are being sampled, an offset
   *     produces duplicates and holes in the sample and gives no sign of it.
   *     An id is fixed: `id < 903` names the same set of older rows whatever
   *     arrives above it.
   *   * The id is the PRIMARY KEY, so `id < ?` is a range scan that starts at
   *     the right row. `LIMIT ? OFFSET 4000` reads and discards four thousand
   *     rows every time, which gets slower the further back an auditor walks —
   *     exactly backwards, since walking back is the whole point.
   *   * A cursor is honest about what it cannot do: it can only walk in the
   *     direction of the sort. Random access into the middle of a log ("page
   *     37") is not a thing anybody sampling a population actually needs, and
   *     an offset offers it while quietly not delivering it under concurrent
   *     writes.
   *
   * There is no `nextCursor` in the response because there does not need to
   * be: the response is a list of events and the cursor for the next page is
   * the `id` of the last one. That keeps this route's shape exactly what it
   * has always been — an array of events — which matters because integrators
   * and every test in this repository already read it that way. How many
   * events matched in total is a different question and has its own answer:
   * `auditSummary` below.
   */
  queryAudit(actorId: string, filter: AuditFilter = {}): AuditEvent[] {
    this.getActor(actorId);
    const { where, params } = this.auditWhere(actorId, filter);
    // Bound, and bound as a parameter rather than as text spliced into SQL: a
    // caller reaching the store directly with a non-numeric limit would
    // otherwise write into the statement.
    const asked = Number(filter.limit ?? AUDIT_PAGE_DEFAULT);
    const limit = Number.isFinite(asked)
      ? Math.min(Math.max(Math.trunc(asked), 1), AUDIT_PAGE_MAX)
      : AUDIT_PAGE_DEFAULT;
    const rows = this.db
      // The page's title and the collection's name travel with the event.
      //
      // The log's "where" column read the word "page" on every page event,
      // which tells somebody scanning a thousand rows nothing (USER-TESTING.md
      // T2.2). The title is not stored ON the event and must not be — an event
      // is a fact about an instant, and a page renamed next year did not
      // retroactively have that name when this happened. So it is joined at
      // READ time and is explicitly the title NOW, which is the right answer
      // for the question this column is actually asked: "which page is this?"
      // A reader who needs the title as it stood at that instant is asking a
      // point-in-time question, and `GET /pages/:id/as-of` answers it properly.
      //
      // The join gives away nothing: `where` has already restricted the rows
      // to events the asker may see, and seeing an event about a page is
      // already seeing that the page exists.
      .prepare(
        `SELECT audit_events.*, pages.title AS page_title, collections.name AS collection_name
         FROM audit_events
         LEFT JOIN pages ON pages.id = audit_events.page_id
         LEFT JOIN collections ON collections.id = audit_events.collection_id
         ${where} ORDER BY audit_events.id DESC LIMIT ?`,
      )
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as string,
      actorId: r.actor_id as string,
      actorKind: r.actor_kind as ActorKind,
      action: r.action as string,
      collectionId: (r.collection_id as string) ?? null,
      pageId: (r.page_id as string) ?? null,
      pageTitle: (r.page_title as string) ?? null,
      collectionName: (r.collection_name as string) ?? null,
      details: redactAuditDetails(
        r.action as string,
        JSON.parse(r.details_json as string) as Record<string, unknown>,
        (r.actor_id as string) === actorId || isOrgOperator(this.db, actorId),
      ),
    }));
  }

  /**
   * How large the filtered population actually is, and what action types are
   * in it. Two answers a screen needs and cannot honestly draw without:
   *
   *   * `matching` is what turns "200 rows" into "200 of 1,187 matching". A
   *     table that shows a page and says nothing about the rest is asserting a
   *     completeness it does not have, which is what made a sample drawn from
   *     this log indefensible.
   *   * `actions` is the action list BUILT FROM THE RECORD. The UI used to
   *     offer a hard-coded sixteen; the record held twenty-two action types,
   *     ten of which no filter could reach, while four of the sixteen offered
   *     never occur. A vocabulary maintained by hand drifts from the log the
   *     moment anybody adds a feature, and it drifts silently, in the
   *     direction of hiding events.
   *
   * The counts in `actions` apply every OTHER filter but not the action
   * filter itself — otherwise choosing an action would collapse the list of
   * actions to the one already chosen, and there would be no way back. A date
   * range or a collection does narrow it, which is the useful behaviour: "what
   * kinds of thing happened in this collection last week" is a real question.
   *
   * `before` is ignored here on purpose. It is a position within a walk, and
   * the size of the population is not a property of where you have got to.
   */
  auditSummary(actorId: string, filter: AuditFilter = {}): AuditSummary {
    this.getActor(actorId);
    const whole = this.auditWhere(actorId, { ...filter, before: undefined });
    const matching = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audit_events ${whole.where}`).get(...whole.params) as { n: number }
    ).n;
    const vocabulary = this.auditWhere(actorId, { ...filter, before: undefined, action: undefined });
    const rows = this.db
      .prepare(`SELECT action, COUNT(*) AS n FROM audit_events ${vocabulary.where} GROUP BY action ORDER BY action`)
      .all(...vocabulary.params) as { action: string; n: number }[];
    return { matching, actions: rows.map((r) => ({ action: r.action, count: r.n })) };
  }

  /**
   * The WHERE clause every audit read shares: the permission rules, then the
   * caller's filters. One place, because a listing, a count and an export that
   * disagreed about who may see what would be a permission bug that only
   * showed up in one of the three.
   */
  private auditWhere(actorId: string, filter: AuditFilter): { where: string; params: (string | number)[] } {
    // Permission filtering happens in the SQL that generates the rows, not
    // after they are read. Two rules, because the log holds two kinds of
    // event:
    //
    //   1. AN EVENT NAMING A COLLECTION reaches a reader only where that
    //      reader holds a role in it. Before this, any actor could read the
    //      whole log, including page ids, titles and send-back comments from
    //      collections they hold no role in.
    //
    //   2. AN EVENT NAMING NO COLLECTION — an agent session, a refused
    //      passport, source administration, an ask that named none — reaches
    //      the actor it is about, and otherwise only an OPERATOR of this Canon
    //      (orgrole.ts: the `operator` or `administrator` org role).
    //      These are the events with no collection to check and the most to
    //      give away: an `agent.session` event carries an agent's entire
    //      permitted-collections and permitted-sources lists, which is a map
    //      of the record's shape drawn for somebody holding no role in any of
    //      it, and an `answer.ask` event carries the question text, which is
    //      often the most sensitive sentence anybody types into Canon.
    //      Leaving them open was the residual of F2 and it is now closed.
    //
    //      This used to read "admin on at least one collection" — the stand-in
    //      SECURITY.md R5 named and said would change the day an org-level role
    //      arrived. It has (SECURITY.md R9/R10 work, orgrole.ts), so the
    //      question asked here is now the real one. A team lead who administers
    //      one collection no longer reads every ask in the organisation, and an
    //      operator who belongs to no collection at all can now do their job.
    //
    // The operator half is decided in TypeScript and bound as a parameter
    // rather than joined in SQL, because it is a property of the ASKER and not
    // of the row. The filter is still in the statement that generates the rows,
    // which is the property F2 turns on.
    //
    // This narrows for agents as well as people, because an agent is an actor.
    // It does not contradict REGISTRY-CONTRACT.md §4.2 — that rule is about
    // narrowing a cross-collection response to `permittedCollections`, and
    // agentauth's `narrow` still applies it on top of whatever survives here.
    // A limit that runs before another limit cannot widen it.
    const clauses: string[] = [
      `(CASE WHEN audit_events.collection_id IS NULL
              THEN audit_events.actor_id = ? OR ? = 1
              ELSE EXISTS (SELECT 1 FROM collection_members m
                            WHERE m.collection_id = audit_events.collection_id AND m.actor_id = ?)
         END)`,
    ];
    const params: (string | number)[] = [actorId, isOrgOperator(this.db, actorId) ? 1 : 0, actorId];
    if (filter.actorId) {
      clauses.push('audit_events.actor_id = ?');
      params.push(filter.actorId);
    }
    if (filter.action) {
      clauses.push('audit_events.action = ?');
      params.push(filter.action);
    }
    // The two filters that were ACCEPTED AND IGNORED (USER-TESTING.md T2.2).
    // They are ordinary columns and always were; nothing here was hard, which
    // is the uncomfortable part. `collection_id` narrows to a collection —
    // note that this is narrower than "everything about this collection",
    // because an event that names no collection (an agent session, a refused
    // passport) is not attributable to one and is therefore correctly absent.
    if (filter.collectionId) {
      clauses.push('audit_events.collection_id = ?');
      params.push(filter.collectionId);
    }
    // A page filter does NOT imply its collection: it is the narrower question
    // and the permission clause above already governs whether the asker may
    // see any of it.
    if (filter.pageId) {
      clauses.push('audit_events.page_id = ?');
      params.push(filter.pageId);
    }
    // Inclusive at both ends, on the stored ISO-8601 UTC text. The caller is
    // responsible for handing in a bound in that same shape — from the HTTP
    // surface that is `instantParam` in input.ts, which is where a bare date
    // becomes the right edge of the day it names.
    if (filter.from) {
      clauses.push('audit_events.at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push('audit_events.at <= ?');
      params.push(filter.to);
    }
    // The cursor. Strictly less-than, so handing back the last id of a page
    // yields the next page with no row repeated and none skipped.
    if (filter.before !== undefined) {
      clauses.push('audit_events.id < ?');
      params.push(filter.before);
    }
    return { where: `WHERE ${clauses.join(' AND ')}`, params };
  }

  // ---- comments, mentions, notifications (Epic C, M2) ------------------
  // Thin delegates; the logic lives in comments.ts and notify.ts.

  // Returns the comment plus what became of its mentions: an `@` naming an
  // actor with no role in this collection is NOT notified (a mention email
  // carries the page title and the comment text), and is reported back to the
  // commenter rather than dropped in silence. See comments.ts, MentionOutcome.
  createComment(
    actorId: string,
    pageId: string,
    input: { body: string; anchor?: Partial<CommentAnchor> | null },
  ): CreatedComment {
    return this.commentService.create(actorId, pageId, input);
  }

  listComments(actorId: string, pageId: string): Comment[] {
    return this.commentService.list(actorId, pageId);
  }

  resolveComment(actorId: string, commentId: string): Comment {
    return this.commentService.resolve(actorId, commentId);
  }

  reopenComment(actorId: string, commentId: string): Comment {
    return this.commentService.reopen(actorId, commentId);
  }

  listNotifications(actorId: string): Notification[] {
    return this.notifier.listFor(actorId);
  }

  // ---- retrieval and grounded answers (Epic D, M3) ---------------------
  // Thin delegates; the logic lives in retrieval.ts and answers.ts.

  async ask(actorId: string, request: AskRequest): Promise<AnswerResponse> {
    const response = await this.answers.ask(actorId, request);
    // The refused-questions loop (gaps.ts). Recording the gap must never cost
    // the asker their refusal: a correct "the record is silent" that 500s
    // because a bookkeeping row failed is the wrong trade, so failures here
    // are logged by being swallowed — the audit event above already holds the
    // question for an operator investigating.
    if (response.refused && request?.question) {
      try {
        this.gapService.recordRefusal(
          String(request.question),
          typeof request.collectionId === 'string' ? request.collectionId : null,
          response.nearest ?? [],
        );
      } catch {
        // Deliberately nothing: see above.
      }
    }
    return response;
  }

  /**
   * Would the record answer this question today? The same retrieval and the
   * same gate as `ask`, and none of the bookkeeping: no audit event, no gap
   * row, no pointers. It runs with `actorId`'s own permissions — there is no
   * other identity to run it as — which is right for its one caller, because
   * the operator reading the annotation is the person who would re-ask.
   *
   * `!refused` is an honest signal here only because a hedge is not an
   * answer. When "Nothing in the record answers this directly" still carried
   * refused:false, this probe said yes to questions a re-ask would show as
   * disowned — the operator's amber "the record now answers this" note was
   * wrong on three of its four gaps in the fourth persona round. Thin
   * grounding refuses now (answers.ts), so yes means "The record says".
   */
  wouldAnswer(actorId: string, question: string, collectionId?: string | null): Promise<boolean> {
    return this.answers
      .ask(actorId, { question, ...(collectionId ? { collectionId } : {}) }, { probe: true })
      .then((response) => !response.refused);
  }

  /**
   * WHO A GAP IS FOR, and this is the one rule in gaps.ts that has moved.
   *
   * It was operators only, carried forward from `redactAuditDetails`: question
   * text is private to the asker and to operators. Round seven measured what
   * that cost. `#/gaps` opened for no collection role, not even `admin`, while
   * the remedy a gap usually needs — teaching a page the asker's word, in the
   * "Also known as" field — lives in the STEWARD's editor. "The gaps list and
   * the fix live with different people."
   *
   * So there are two scopes and they are the same list, narrowed:
   *
   *   * an OPERATOR reads every gap, as before, including the ones asked
   *     across the whole record with no collection attached;
   *   * an ADMINISTRATOR OF A COLLECTION reads the gaps recorded against the
   *     collections they administer, and nothing else.
   *
   * The redaction rule is not weakened by this, and the reason is structural
   * rather than a promise: the harmful disclosure was never the question, it
   * was the LINK between a person and what they did not know, and the gaps
   * table has no asker column for anybody at any role to join on. What a
   * steward gains is a question asked of their own material.
   *
   * `nearest` is filtered to what THIS reader may see. It was recorded from
   * the asker's own permission-filtered results, so it is very unlikely to
   * hold anything a steward of that collection cannot open — but "very
   * unlikely" is not a rule, and a page title is identity.
   */
  async listGaps(actorId: string, filter: { status?: string } = {}): Promise<Gap[]> {
    const scope = this.gapScope(actorId);
    const gaps = this.gapService.list(
      scope.scope === 'operator' ? filter : { ...filter, collectionIds: scope.collectionIds },
    );
    if (scope.scope === 'steward') for (const gap of gaps) gap.nearest = this.visibleNearest(actorId, gap.nearest);
    // Which open gaps the record has since learned to answer (`wouldAnswer`).
    // Capped at the first 50 open gaps — the list is ordered by last asking,
    // so the cap lands on the gaps nobody has touched in longest, and a
    // triage screen's load stays bounded by a constant rather than by how
    // far behind the triage is. Beyond the cap the flag is simply absent,
    // which the UI reads as "not probed", never as "still refused".
    let probes = 0;
    for (const gap of gaps) {
      if (gap.status !== 'open' || probes >= 50) continue;
      probes += 1;
      try {
        gap.nowAnswers = await this.wouldAnswer(actorId, gap.question, gap.collectionId);
      } catch {
        // The annotation is advisory; a probe that fails leaves the gap
        // unannotated rather than costing the operator the list.
      }
    }
    return gaps;
  }

  /**
   * Which gaps this actor may read, and under which of the two rules above.
   * Refuses in `requireOrgRole`'s own words when the answer is neither — the
   * sentence that names the role, says where to ask, and (still correctly)
   * distinguishes administering ONE collection from running the Canon: a
   * steward now reads that collection's gaps, and the whole record's gaps
   * remain the operator's.
   */
  private gapScope(actorId: string): { scope: 'operator' | 'steward'; collectionIds: string[] } {
    if (this.isOperator(actorId)) return { scope: 'operator', collectionIds: [] };
    const collectionIds = (
      this.db
        .prepare("SELECT collection_id FROM collection_members WHERE actor_id = ? AND role = 'admin'")
        .all(actorId) as { collection_id: string }[]
    ).map((row) => row.collection_id);
    if (!collectionIds.length) requireOrgRole(this.db, actorId, 'operator', 'Reading the record’s gaps');
    return { scope: 'steward', collectionIds };
  }

  /** The scope this actor reads gaps under, for a screen that must say so. */
  gapScopeOf(actorId: string): { scope: 'operator' | 'steward'; collectionIds: string[] } {
    return this.gapScope(actorId);
  }

  /** Gap pointers narrowed to pages this actor may open. See `listGaps`. */
  private visibleNearest(actorId: string, nearest: { pageId: string; title: string }[]): { pageId: string; title: string }[] {
    if (!nearest.length) return nearest;
    const ids = nearest.map((n) => n.pageId);
    const visible = new Set(
      (
        this.db
          .prepare(
            `SELECT p.id FROM pages p
               JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
              WHERE p.id IN (${ids.map(() => '?').join(', ')})`,
          )
          .all(actorId, ...ids) as { id: string }[]
      ).map((row) => row.id),
    );
    return nearest.filter((n) => visible.has(n.pageId));
  }

  closeGap(
    actorId: string,
    gapId: string,
    input: { outcome?: string; note?: string | null } = {},
  ): Gap {
    // Closing follows reading: whoever the gap is FOR is who records what was
    // done about it. A steward who added the alias is the person with the
    // sentence worth keeping, and making them ask an operator to type it is
    // how a loop stops being a loop.
    const scope = this.gapScope(actorId);
    if (scope.scope === 'steward') {
      const gap = this.gapService.get(gapId);
      // A gap outside their collections reads as no such gap: the same answer
      // an invented id gets, so a steward cannot learn what other collections
      // are being asked about by trying ids.
      if (!gap || !gap.collectionId || !scope.collectionIds.includes(gap.collectionId)) {
        throw new CanonError('not_found', `No such gap: ${gapId}`);
      }
    }
    const outcome = input.outcome === 'dismissed' ? 'dismissed' : input.outcome === 'resolved' ? 'resolved' : null;
    if (!outcome) throw new CanonError('invalid', "Closing a gap is 'resolved' or 'dismissed'");
    const gap = this.gapService.close(actorId, gapId, outcome, input.note ?? null);
    this.audit(actorId, `gap.${outcome}`, {
      details: { gapId, question: gap.question, ...(gap.resolution ? { note: gap.resolution } : {}) },
    });
    return gap;
  }

  retrieve(actorId: string, request: RetrieveRequest): Promise<RetrievalCandidate[]> {
    return this.retrieval.retrieve(actorId, request);
  }

  related(
    actorId: string,
    pageId: string,
    opts: { canonicalOnly?: boolean; limit?: number } = {},
  ): RetrievalCandidate[] {
    return this.retrieval.related(actorId, pageId, opts);
  }

  // ---- audit export and import (Epic E, M4) ----------------------------
  // Thin delegates; the logic lives in csv.ts and import.ts. The importer is
  // stateless apart from the record it writes to, so it is built per call.

  /**
   * The export, and it is the whole filtered population rather than the first
   * page of it.
   *
   * This used to hand `queryAudit` a limit and return whatever came back —
   * which, once `queryAudit` gained a page size, meant an auditor exporting
   * "everything by this actor" received the most recent 1,000 rows of it with
   * nothing on the file to say so. That is the screen's "200 of 1,187 in
   * silence" defect (USER-TESTING.md T2.2) reproduced in the one artefact that
   * leaves the building and gets attached to a report.
   *
   * So it walks, using the same cursor a reader walks with: take a page, take
   * the id of its last row, ask for the next page below it. The walk stops at
   * `AUDIT_CSV_MAX_ROWS` because the file is built in memory as one string and
   * something has to bound it — and when it stops there, `x-canon-truncated`
   * says so on the response rather than leaving the reader to infer it.
   *
   * The filter is the full `AuditFilter` minus `before` and `limit`: a walk
   * starts at the top of the filtered population by definition, and its size
   * is the cap, so accepting either would only let a caller ask for something
   * this method then has to override.
   */
  auditCsv(actorId: string, filter: Omit<AuditFilter, 'before' | 'limit'> = {}): RawResponse {
    const events: AuditEvent[] = [];
    let before: number | undefined;
    for (;;) {
      const room = AUDIT_CSV_MAX_ROWS - events.length;
      if (room <= 0) break;
      const page = this.queryAudit(actorId, {
        ...filter,
        before,
        limit: Math.min(AUDIT_CSV_PAGE_ROWS, room),
      });
      events.push(...page);
      // Short page means the population is exhausted. `at` is not unique — a
      // seeded record has 1,100 events sharing one instant — so the cursor is
      // the id, which is.
      if (page.length < Math.min(AUDIT_CSV_PAGE_ROWS, room)) break;
      before = page[page.length - 1]!.id;
    }
    // The export is itself on the record. It used to be the one act this log
    // did not hold — the log left the building without the log saying so
    // (fourth round, Ruth). What is recorded is the act, never the payload:
    // who exported, the filter in effect (actions, ids and dates — no
    // question texts live in a filter), how many rows went out, and whether
    // the cap cut the file short. Written AFTER the walk, so no file contains
    // its own export; the next one carries it, which keeps the trail
    // walkable. The event names no collection, so it reaches the exporter and
    // operators — the same rule every other collectionless event follows.
    this.audit(actorId, 'audit.exported', {
      details: {
        ...(filter.actorId ? { actorId: filter.actorId } : {}),
        ...(filter.action ? { action: filter.action } : {}),
        ...(filter.collectionId ? { collectionId: filter.collectionId } : {}),
        ...(filter.pageId ? { pageId: filter.pageId } : {}),
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.to ? { to: filter.to } : {}),
        rows: events.length,
        truncated: events.length >= AUDIT_CSV_MAX_ROWS,
      },
    });
    return auditCsvResponse(events);
  }

  runImport(actorId: string, input: ImportInput): ImportSummary {
    return new ImportService(this.db, this).run(actorId, input);
  }

  runImportUpload(actorId: string, input: ImportUploadInput): ImportSummary {
    return new ImportService(this.db, this).runFromArchive(actorId, input);
  }

  getImportRun(actorId: string, runId: string): ImportRunRecord {
    return new ImportService(this.db, this).getRun(actorId, runId);
  }

  listImportRuns(actorId: string): Omit<ImportRunRecord, 'items' | 'files'>[] {
    return new ImportService(this.db, this).listRuns(actorId);
  }

  // ---- asking for access (access.ts) -----------------------------------
  //
  // The service resolves the REFUSAL and never a page id; what the store adds
  // is the two things a service with no notifier and no audit cannot do —
  // telling the people who can decide, and putting the decision on the record.

  requestAccess(actorId: string, input: AccessRequestInput): AskedAccessRequest {
    // The row exists first; telling people is a consequence of it, exactly as
    // it is for every other notification in this record. `collectionId` is the
    // half of the answer the ASKER may not have (access.ts, `ask`) — it is used
    // here and never returned.
    const { request, collectionId } = this.accessRequests.ask(this, actorId, input);
    const asker = this.getActor(actorId);
    const name = this.accessRequests.collectionNameFor(collectionId);
    for (const deciderId of this.accessRequests.decidersOf(collectionId)) {
      if (deciderId === actorId) continue;
      this.notifier.send(deciderId, {
        kind: 'access_requested',
        subject: `${asker.name} is asking for access to ${name}`,
        // The asker's own sentence, which is what the decision is made on.
        body: request.note ?? '',
        link: '/queue',
      });
    }
    // Audited on the collection it is about, so the log reads "who asked for
    // what, and when" beside the grant that may follow it.
    this.audit(actorId, 'access.requested', {
      collectionId,
      details: {
        requestId: request.id,
        ground: request.ground,
        ...(request.requestedRole ? { requestedRole: request.requestedRole } : {}),
      },
    });
    return request;
  }

  /** The inbox: open requests waiting on this actor as an administrator. */
  listAccessRequests(actorId: string, opts: { status?: AccessRequestStatus | 'all' } = {}): AccessRequest[] {
    return this.accessRequests.listForDecider(this, actorId, opts);
  }

  /** What this actor has asked for, in the thinner view their own refusal earned. */
  listMyAccessRequests(actorId: string): AskedAccessRequest[] {
    return this.accessRequests.listForAsker(this, actorId);
  }

  /**
   * Grant or decline. The grant goes through `setMember` — one road into
   * membership, so the system actor, the last-administrator rule, group grants
   * and the audit event all apply exactly as they do on the Members screen.
   */
  decideAccessRequest(
    actorId: string,
    requestId: string,
    input: { outcome?: string; role?: Role; note?: string | null },
  ): AccessRequest {
    const { request, grant } = this.accessRequests.decide(this, actorId, requestId, input);
    if (grant) this.setMember(actorId, request.collectionId, grant.memberId, grant.role);
    const decider = this.getActor(actorId);
    const name = this.accessRequests.collectionNameFor(request.collectionId);
    this.notifier.send(request.askerId, {
      kind: 'access_decided',
      // A GRANT may name the collection: the asker can see it now, so the name
      // is the answer rather than a disclosure. A DECLINE may not — they were
      // refused, and a notice that names what they were refused would hand over
      // exactly what the refusal withheld.
      subject:
        request.status === 'granted'
          ? `${decider.name} gave you ${request.grantedRole} on ${name}`
          : 'Your request for access was declined',
      body: request.decisionNote ?? '',
      link: request.status === 'granted' && request.ground === 'collection' ? `/collections/${request.collectionId}` : '/queue',
    });
    this.audit(actorId, `access.${request.status}`, {
      collectionId: request.collectionId,
      details: {
        requestId: request.id,
        askerId: request.askerId,
        ...(request.grantedRole ? { grantedRole: request.grantedRole } : {}),
        ...(request.decisionNote ? { note: request.decisionNote } : {}),
      },
    });
    return request;
  }

  withdrawAccessRequest(actorId: string, requestId: string): AskedAccessRequest {
    return this.accessRequests.withdraw(this, actorId, requestId);
  }

  // ---- federation: sources and reference fields (DATA-BACKBONE.md §6) ---
  // Thin delegates; the logic lives in sources.ts, connectors.ts, references.ts.

  createSource(actorId: string, input: SourceInput): Source {
    return this.sources.create(actorId, input);
  }

  listSources(actorId: string): Source[] {
    return this.sources.list(actorId);
  }

  getSource(actorId: string, id: string): Source {
    return this.sources.get(actorId, id);
  }

  updateSource(actorId: string, id: string, input: Partial<SourceInput>): Source {
    return this.sources.update(actorId, id, input);
  }

  deleteSource(actorId: string, id: string): void {
    this.sources.remove(actorId, id);
  }

  /** What this actor may do to this source, and where they may not, who can. */
  sourceAbilities(actorId: string, source: Source): SourceAbilities {
    return this.sources.abilities(actorId, source);
  }

  /** Whether this actor may register a source at all — the one control that exists before one does. */
  sourceRegisterAbility(actorId: string): PageAbility {
    return this.sources.registerAbility(actorId);
  }

  addReference(actorId: string, pageId: string, input: ReferenceInput): PageReference {
    return this.references.add(actorId, pageId, input);
  }

  listReferences(actorId: string, pageId: string): PageReference[] {
    return this.references.list(actorId, pageId);
  }

  /**
   * The pages this body links to that `actorId` may not read.
   *
   * A body is prose, and prose names things. A page written by somebody with
   * wider access can say "superseded by [Q3 Workforce Reduction Plan](/pages/…)"
   * and Canon will show that sentence, verbatim, to every reader of THIS page —
   * in the page, in a search snippet, and inside an extractive answer that
   * quotes the passage. The title of a page they were refused, handed over in
   * the body of one they were granted.
   *
   * Not all of that is fixable, and pretending otherwise would be the worse
   * error: a body that merely MENTIONS a title in prose is indistinguishable
   * from any other sentence, and no permission check can find it. What IS
   * findable is a link, because a link carries the page id — so the id can be
   * tested against the reader the same way every other read is, and the label
   * beside it suppressed when the test fails. The rest is what the publish-time
   * warning to the AUTHOR is for; they are the only one who can judge prose.
   *
   * Returned as a list of ids for the renderer to match on, never as a rewritten
   * body: the editor loads the same version, and a body silently redacted on
   * read is a body an author saves back with their own link destroyed.
   */
  withheldLinks(actorId: string, body: string): string[] {
    const linked = parsePageLinks(body ?? '');
    if (!linked.length) return [];
    const out: string[] = [];
    for (const id of linked) {
      const row = this.db.prepare('SELECT collection_id FROM pages WHERE id = ?').get(id) as
        | { collection_id: string }
        | undefined;
      // An id that names no page is just text, exactly as retrieval treats it —
      // and reporting it as withheld would tell a reader that a page exists
      // where none does.
      if (!row) continue;
      if (!this.roleOf(actorId, row.collection_id)) out.push(id);
    }
    return out;
  }

  removeReference(actorId: string, referenceId: string): void {
    this.references.remove(actorId, referenceId);
  }

  resolveReferences(actorId: string, pageId: string): Promise<ResolvedReference[]> {
    return this.references.resolveReferences(actorId, pageId);
  }

  /**
   * The answer path's view of a cited page's federated fields (answers.ts,
   * `CitationField`): nothing when the page has none — the common case, paid
   * for with one cheap list — and otherwise the same resolution the page view
   * itself performs, cache-within-freshness, stale-marked, never guessed.
   */
  async liveFields(actorId: string, pageId: string): Promise<CitationField[]> {
    if (this.references.list(actorId, pageId).length === 0) return [];
    const resolved = await this.references.resolveReferences(actorId, pageId);
    return resolved.map((r) => ({
      label: r.label ?? r.key,
      value: r.value,
      sourceName: r.sourceName,
      role: r.role,
      resolvedAt: r.resolvedAt,
      stale: r.stale,
      ...(r.error ? { error: r.error } : {}),
    }));
  }

  // ---- divergence (DATA-BACKBONE.md §7) --------------------------------
  // Thin delegates; the logic and the argument live in divergence.ts. Opening
  // one has no delegate at all: a divergence is only ever OBSERVED, by the
  // reference layer, when a corroborating source disagrees with its authority.
  // There is no way to assert one by hand, because a contradiction Canon did
  // not see is not something it may claim to have seen.

  listPageDivergences(actorId: string, pageId: string, filter: { state?: DivergenceState } = {}): Divergence[] {
    return this.divergences.listForPage(actorId, pageId, filter);
  }

  listDivergences(actorId: string, filter: DivergenceFilter = {}): Divergence[] {
    return this.divergences.list(actorId, filter);
  }

  getDivergence(actorId: string, id: string): Divergence {
    return this.divergences.get(actorId, id);
  }

  closeDivergence(actorId: string, id: string, input: { reason?: string } = {}): Divergence {
    return this.divergences.close(actorId, id, input);
  }

  // ---- agent proposals (FEATURES.md §5; the Next tier) ------------------
  // Thin delegates; the logic and the model note live in proposals.ts. A
  // proposal is held in its own table, never in `drafts`, so it cannot take
  // the page lock: a page carries any number of open proposals while a person
  // edits it normally.

  createProposal(actorId: string, pageId: string, input: ProposalInput): Proposal {
    return this.proposals.create(actorId, pageId, input);
  }

  listProposals(actorId: string, pageId: string, filter: { status?: ProposalStatus } = {}): Proposal[] {
    return this.proposals.list(actorId, pageId, filter);
  }

  acceptProposal(actorId: string, proposalId: string, input: { note?: string } = {}): ProposalDecision {
    return this.proposals.accept(actorId, proposalId, input);
  }

  rejectProposal(actorId: string, proposalId: string, input: { comment: string }): Proposal {
    return this.proposals.reject(actorId, proposalId, input);
  }

  // ---- page relations (DATA-BACKBONE.md §7) -----------------------------
  // Thin delegates; the logic and the model note live in relations.ts. A
  // relation is asserted by a person, requires `edit` on BOTH pages'
  // collections, and is drawn on the knowledge map because it is explicit.

  assertRelation(actorId: string, fromPageId: string, input: RelationInput): PageRelationView {
    return this.relations.assert(actorId, fromPageId, input);
  }

  listRelations(actorId: string, pageId: string): PageRelationView[] {
    return this.relations.list(actorId, pageId);
  }

  removeRelation(actorId: string, relationId: string): void {
    this.relations.remove(actorId, relationId);
  }

  /** Every asserted conflict against a page this owner is accountable for. */
  listConflictsForOwner(actorId: string, ownerId: string, options: { limit?: number } = {}): OwnedConflict[] {
    return this.relations.listConflictsForOwner(actorId, ownerId, options);
  }

  // ---- the queue (USER-TESTING.md T2.1) ---------------------------------
  // A thin delegate; the argument lives in queue.ts. It answers for the ASKING
  // actor and takes no subject parameter, deliberately: see the note there.

  myQueue(actorId: string, options: { on?: string } = {}): WorkQueue {
    return this.queue.queue(actorId, options);
  }

  /**
   * The one seam proposals.ts needs: publish accepted proposal content as a
   * new version authored by `authorId` — the proposer, typically an agent —
   * on the accepting person's behalf. It runs the type's rules and the same
   * version-writing path `publish()` uses, so an accepted proposal on a
   * reviewed type lands at Draft and still reaches Canonical only through
   * `submitForReview` and its named approver. Not part of the HTTP surface;
   * acceptance is reached through `acceptProposal`, which is where the
   * proposal's own guards (lock, base version, person-only) live.
   */
  publishAcceptedProposal(
    actorId: string,
    authorId: string,
    pageId: string,
    content: { title: string; body: string; fields: PageFields; note: string | null },
  ): Page {
    const page = this.toPage(this.pageRow(pageId));
    this.requireRole(actorId, page.collectionId, 'edit');
    this.validateReadyToPublish(page.type, content.fields);
    return this.writeVersion(actorId, page, content, { authorId });
  }

  // ---- the Knowledge API's two seams (STUDIO-CONTRACT.md) ---------------
  // Veryl Studio's Knowledge API evaluates a three-way intersection on every
  // call: the app's Registry limits, the app's Canon permissions, and the
  // permissions of the person the app acts for. The app's half is the store
  // call itself, made with the app's actor id, exactly as it always was.
  // These two thin delegates are what the person's half and the dual-attributed
  // audit event need, and they exist so neither grows a second copy.

  /**
   * "May this actor do this here?", asked without doing it. `requireRole` is
   * the store's single implementation of that question; the Knowledge API
   * needs it for the person it is acting for, before the app acts.
   */
  requireRoleFor(actorId: string, collectionId: string, needed: Role): void {
    this.requireRole(actorId, collectionId, needed);
  }

  /**
   * A page's collection, by existence alone — no permission, `not_found` only
   * for a page that genuinely is not there. The Knowledge API needs this to ask
   * its two gates (`requireRoleFor` for the person, then the app) as the labelled
   * `person_not_permitted` / `app_not_permitted` refusals its contract requires.
   * `getPage` cannot serve that anymore: its refusal to a stranger is now the
   * same existence-masking `not_found` a missing page gives (P1, abilities.ts),
   * which is right for a human at the boundary but would collapse "the person
   * holds no role" into "no such page" for an app that can plainly see it.
   */
  pageCollectionId(pageId: string): string {
    return this.pageRow(pageId).collection_id as string;
  }

  /**
   * Append one audit event through the store's own writer, so the Knowledge
   * API's events — which name the app AND the person — sit in the same
   * append-only log, in the same shape, as everything else.
   */
  recordAudit(
    actorId: string,
    action: string,
    ctx: { collectionId?: string; pageId?: string; details?: Record<string, unknown> } = {},
  ): void {
    this.audit(actorId, action, ctx);
  }

  // ---- freshness and structured queries (Next tier) ---------------------
  // Thin delegates; the logic lives in freshness.ts and queries.ts.

  // The freshness sweep, behind POST /maintenance/freshness. A deployment also
  // runs it on a timer, exactly as it runs the notification flush (index.ts).
  sweepFreshness(actorId: string, options: FreshnessSweepOptions = {}): FreshnessSweepResult {
    return this.freshness.sweep(actorId, options);
  }

  runQuery(actorId: string, query: PageQuery = {}): QueryResultPage[] {
    return this.queries.run(actorId, query);
  }

  saveQuery(actorId: string, input: { name: string; query?: PageQuery }): SavedQuery {
    return this.queries.save(actorId, input);
  }

  listQueries(actorId: string): SavedQuery[] {
    return this.queries.list(actorId);
  }

  getQuery(actorId: string, id: string): SavedQuery {
    return this.queries.get(actorId, id);
  }

  deleteQuery(actorId: string, id: string): void {
    this.queries.remove(actorId, id);
  }

  runSavedQuery(actorId: string, id: string, overrides: Partial<PageQuery> = {}): QueryResultPage[] {
    return this.queries.runSaved(actorId, id, overrides);
  }

  collectionHealth(
    actorId: string,
    collectionId: string,
    options: { staleDraftDays?: number; on?: string } = {},
  ): CollectionHealth {
    return this.queries.health(actorId, collectionId, options);
  }

  // ---- the knowledge map ------------------------------------------------
  // A thin delegate; the logic lives in graph.ts. Built per call, like the
  // importer: the service holds nothing between requests, and a map is one
  // read of the record as the asking actor may see it.

  collectionGraph(actorId: string, collectionId: string): KnowledgeGraph {
    return new GraphService(this.db, this).graph(actorId, collectionId);
  }

  /** The same graph at the record's altitude: every collection the asker may view. */
  recordGraph(actorId: string, options: RecordGraphOptions = {}): RecordGraph {
    return new GraphService(this.db, this).recordGraph(actorId, options);
  }

  // ---- attestation and export (FEATURES.md §7) --------------------------
  // Thin delegates; the logic lives in attestation.ts and the hash chain in
  // auditchain.ts. Built per call, like the importer and the graph: an
  // attestation is one read of immutable history as the asking actor may see
  // it, and the service holds nothing between requests.

  /**
   * Walk the audit hash chain and report the first break. Permission is the
   * operator stand-in Core already uses — admin on at least one collection —
   * for the same reason the freshness sweep and the outbox flush use it: the
   * chain spans every collection, so there is no collection to check it
   * against, and a per-collection answer would be a partial answer to a
   * question that is only useful whole. See SECURITY.md R5 on that stand-in.
   */
  verifyAuditChain(actorId: string, options: { limit?: number } = {}): AuditChainVerification {
    this.getActor(actorId);
    const admin = this.db
      .prepare("SELECT 1 AS ok FROM collection_members WHERE actor_id = ? AND role = 'admin' LIMIT 1")
      .get(actorId) as { ok: number } | undefined;
    if (!admin) {
      // THE SECOND VOCABULARY, one survivor of it. "Requires admin on a
      // collection" is the sentence the second round of testing spent a whole
      // pass removing: it names no act, says nothing about what the caller
      // holds, and gives nobody to ask. It survived here because this is the
      // one check that is about NO collection in particular — the chain spans
      // all of them — so `forbiddenRole` has nothing to name and the call site
      // wrote its own words instead.
      //
      // It says the same three things the rest of the product's refusals say,
      // in the shape this check's own rule takes. Who holds admin somewhere is
      // deliberately NOT named: that list would be assembled across every
      // collection, including ones the caller holds no role in, and a refusal
      // is not a place to hand out a membership list they were refused.
      throw new CanonError(
        'forbidden',
        'Checking the audit chain needs the admin role on a collection — any one of them, because the chain ' +
          'spans them all and a partial walk is not an answer. You hold it on none. An administrator of a ' +
          'collection can grant it.',
        { needed: 'admin' satisfies Role },
      );
    }
    return verifyAuditChain(this.db, options);
  }

  /** What did this page say at that instant, and who had approved it. */
  pageAsOf(actorId: string, pageId: string, at: string): PageAsOf {
    return new AttestationService(this.db, this).asOf(actorId, pageId, at);
  }

  /** The attestation bundle for one page. Generating one is an audited act. */
  pageAttestation(
    actorId: string,
    pageId: string,
    opts: { at?: string; format?: 'json' | 'html' } = {},
  ): PageAttestation {
    return new AttestationService(this.db, this).bundle(actorId, pageId, opts);
  }

  /** The register of a collection's Canonical pages as at a date. */
  collectionAttestation(
    actorId: string,
    collectionId: string,
    opts: { at?: string; format?: 'json' | 'html' } = {},
  ): CollectionAttestation {
    return new AttestationService(this.db, this).register(actorId, collectionId, opts);
  }
}
