import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
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
  PageFields,
  PageVersion,
  Role,
  ROLE_RANK,
  TYPE_RULES,
} from './model.js';
import { SearchIndex } from './search.js';
import { Comment, CommentAnchor, CommentService, CreatedComment } from './comments.js';
import { Notification, NotificationTransport, Notifier } from './notify.js';
import { EmbeddingProvider, EmbeddingStore } from './embeddings.js';
import { RetrievalCandidate, RetrievalService, RetrieveRequest } from './retrieval.js';
import { AnswerResponse, AnswerService, AskRequest } from './answers.js';
import { AUDIT_CSV_MAX_ROWS, RawResponse, auditCsvResponse } from './csv.js';
import { ImportInput, ImportRunRecord, ImportService, ImportSummary } from './import.js';
import { ConnectorRegistry, defaultConnectorRegistry } from './connectors.js';
import { Source, SourceInput, SourceService } from './sources.js';
import { PageReference, ReferenceInput, ReferenceService, ResolvedReference } from './references.js';
import { Proposal, ProposalDecision, ProposalInput, ProposalService, ProposalStatus } from './proposals.js';
import { FreshnessService, FreshnessSweepOptions, FreshnessSweepResult, isIsoDate } from './freshness.js';
import { CollectionHealth, PageQuery, QueryResultPage, QueryService, SavedQuery } from './queries.js';
import { GraphService, KnowledgeGraph, RecordGraph, RecordGraphOptions } from './graph.js';
import { AuditChainVerification, verifyAuditChain } from './auditchain.js';
import {
  AttestationService,
  CollectionAttestation,
  PageAsOf,
  PageAttestation,
} from './attestation.js';

export interface TreeNode extends Page {
  children: TreeNode[];
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
  private readonly answers: AnswerService;
  // Federation (DATA-BACKBONE.md §6) lives in sources.ts, connectors.ts and
  // references.ts. The connector registry is a deployment's seam: it defaults
  // to the hermetic static connector so everything runs with no external
  // calls, and a real integration registers itself on it.
  readonly connectors: ConnectorRegistry;
  private readonly sources: SourceService;
  private readonly references: ReferenceService;
  // Agent proposals (FEATURES.md §5, Next tier) live in proposals.ts. A
  // proposal is held apart from the draft on purpose, so it never takes the
  // page lock; see the model note at the top of that file.
  private readonly proposals: ProposalService;
  // Freshness and structured queries (Next tier) live in freshness.ts and
  // queries.ts; delegates at the end of this class, same as everything above.
  private readonly freshness: FreshnessService;
  private readonly queries: QueryService;

  constructor(
    private readonly db: DatabaseSync,
    transport?: NotificationTransport,
    embeddingProvider?: EmbeddingProvider,
    connectors: ConnectorRegistry = defaultConnectorRegistry(),
  ) {
    this.searchIndex = new SearchIndex(db);
    this.embeddings = new EmbeddingStore(db, embeddingProvider);
    this.notifier = new Notifier(db, this, transport);
    this.commentService = new CommentService(db, this, this.notifier);
    this.retrieval = new RetrievalService(db, this, this.searchIndex, this.embeddings);
    this.answers = new AnswerService(db, this, this.retrieval);
    this.connectors = connectors;
    this.sources = new SourceService(db, this);
    this.references = new ReferenceService(db, this, this.sources, this.connectors);
    this.proposals = new ProposalService(db, this, this.notifier);
    this.freshness = new FreshnessService(db, this, this.notifier);
    this.queries = new QueryService(db, this);
  }

  // ---- actors ----------------------------------------------------------

  createActor(input: { kind: ActorKind; name: string; email?: string; registryRef?: string }): Actor {
    if (input.kind === 'agent' && !input.registryRef) {
      throw new CanonError('invalid', 'An agent actor requires a Registry reference (Agent Passport)');
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

  listActors(): Actor[] {
    const rows = this.db.prepare('SELECT id FROM actors ORDER BY created_at').all() as { id: string }[];
    return rows.map((r) => this.getActor(r.id));
  }

  // ---- permissions -----------------------------------------------------

  roleOf(actorId: string, collectionId: string): Role | null {
    const row = this.db
      .prepare('SELECT role FROM collection_members WHERE collection_id = ? AND actor_id = ?')
      .get(collectionId, actorId) as { role: Role } | undefined;
    return row?.role ?? null;
  }

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      throw new CanonError('forbidden', `Requires ${needed} access to this collection`, {
        collectionId,
        needed,
        held: role,
      });
    }
  }

  setMember(actorId: string, collectionId: string, memberId: string, role: Role): void {
    this.requireRole(actorId, collectionId, 'admin');
    this.getActor(memberId);
    this.db
      .prepare(
        `INSERT INTO collection_members (collection_id, actor_id, role) VALUES (?, ?, ?)
         ON CONFLICT (collection_id, actor_id) DO UPDATE SET role = excluded.role`,
      )
      .run(collectionId, memberId, role);
    this.audit(actorId, 'collection.member_set', { collectionId, details: { memberId, role } });
  }

  removeMember(actorId: string, collectionId: string, memberId: string): void {
    this.requireRole(actorId, collectionId, 'admin');
    this.db
      .prepare('DELETE FROM collection_members WHERE collection_id = ? AND actor_id = ?')
      .run(collectionId, memberId);
    this.audit(actorId, 'collection.member_removed', { collectionId, details: { memberId } });
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
    this.db
      .prepare('INSERT INTO collection_members (collection_id, actor_id, role) VALUES (?, ?, ?)')
      .run(collection.id, actorId, 'admin');
    this.audit(actorId, 'collection.create', { collectionId: collection.id, details: { name: collection.name } });
    return collection;
  }

  getCollection(actorId: string, id: string): Collection {
    const row = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such collection: ${id}`);
    this.requireRole(actorId, id, 'view');
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      restricted: (row.restricted as number) === 1,
      createdAt: row.created_at as string,
      archivedAt: (row.archived_at as string) ?? null,
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

  createPage(
    actorId: string,
    input: { collectionId: string; parentId?: string | null; type: DocType; title: string },
  ): Page {
    this.requireRole(actorId, input.collectionId, 'edit');
    if (!DOC_TYPES.includes(input.type)) throw new CanonError('invalid', `Unknown document type: ${input.type}`);
    if (!input.title?.trim()) throw new CanonError('invalid', 'A page requires a title');
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
        `INSERT INTO pages (id, collection_id, parent_id, position, type, title, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(id, input.collectionId, input.parentId ?? null, position, input.type, input.title.trim(), actorId, now());
    this.audit(actorId, 'page.create', {
      collectionId: input.collectionId,
      pageId: id,
      details: { type: input.type, title: input.title.trim() },
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
    this.requireRole(actorId, collectionId, 'view');
    const page = this.toPage(row);
    if (opts.logView) {
      const restricted = (
        this.db.prepare('SELECT restricted FROM collections WHERE id = ?').get(collectionId) as {
          restricted: number;
        }
      ).restricted;
      if (restricted === 1) {
        this.audit(actorId, 'page.view', { collectionId, pageId: id });
      }
    }
    return page;
  }

  private toPage(row: Record<string, unknown>): Page {
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      parentId: (row.parent_id as string) ?? null,
      position: row.position as number,
      type: row.type as DocType,
      title: row.title as string,
      status: row.status as Page['status'],
      ownerId: (row.owner_id as string) ?? null,
      approverId: (row.approver_id as string) ?? null,
      effectiveDate: (row.effective_date as string) ?? null,
      reviewDate: (row.review_date as string) ?? null,
      currentVersion: (row.current_version as number) ?? null,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
    };
  }

  tree(actorId: string, collectionId: string): TreeNode[] {
    this.requireRole(actorId, collectionId, 'view');
    const rows = this.db
      .prepare("SELECT * FROM pages WHERE collection_id = ? AND status != 'archived' ORDER BY position")
      .all(collectionId) as Record<string, unknown>[];
    const nodes = new Map<string, TreeNode>();
    for (const row of rows) nodes.set(row.id as string, { ...this.toPage(row), children: [] });
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
    this.requireRole(actorId, row.collection_id as string, 'edit');
    this.db.prepare("UPDATE pages SET status = 'archived' WHERE id = ?").run(pageId);
    this.searchIndex.indexPage(pageId); // archived pages leave search
    this.embeddings.indexPage(pageId); // and leave the vector index too
    this.audit(actorId, 'page.archive', { collectionId: row.collection_id as string, pageId });
    return this.getPage(actorId, pageId);
  }

  // ---- drafts and the page lock ---------------------------------------

  editDraft(
    actorId: string,
    pageId: string,
    input: { title?: string; body?: string; fields?: PageFields },
  ): Draft {
    const row = this.pageRow(pageId);
    this.requireRole(actorId, row.collection_id as string, 'edit');
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

    if (input.fields) this.validateFieldShape(page.type, input.fields);

    const base = existing ?? this.draftSeed(page);
    const fields: PageFields = { ...(JSON.parse(base.fields_json as string) as PageFields), ...(input.fields ?? {}) };
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
    return this.getDraft(actorId, pageId)!;
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
          reviewDate: page.reviewDate,
        } satisfies PageFields),
    };
  }

  getDraft(actorId: string, pageId: string): Draft | null {
    const row = this.pageRow(pageId);
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

  private validateFieldShape(type: DocType, fields: PageFields): void {
    if (fields.effectiveDate && !TYPE_RULES[type].allowsEffectiveDate) {
      throw new CanonError('invalid', `Effective date applies only to Policy pages, not ${type}`);
    }
    // Freshness: the review date is a typed field, so its shape is checked the
    // same way the effective date's is, and which types may carry one is
    // TYPE_RULES' answer rather than a test written at this call site.
    if (fields.reviewDate) {
      if (!TYPE_RULES[type].allowsReviewDate) {
        throw new CanonError('invalid', `A ${type} carries no review date; it never holds the Canonical mark`);
      }
      if (!isIsoDate(fields.reviewDate)) {
        throw new CanonError('invalid', `A review date is an ISO date (YYYY-MM-DD), not '${fields.reviewDate}'`);
      }
    }
    for (const key of ['ownerId', 'approverId'] as const) {
      const value = fields[key];
      if (value) this.getActor(value);
    }
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
  }

  // ---- publishing and history ------------------------------------------

  publish(actorId: string, pageId: string, input: { note?: string } = {}): Page {
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
    return this.writeVersion(actorId, page, {
      title: draft.title as string,
      body: draft.body as string,
      fields,
      note: input.note ?? null,
    });
  }

  // Creates the next immutable version, updates the current pointer and the
  // page's structured fields, clears the draft, and settles status: a Note
  // stays a working note; a reviewed type returns to Draft because the
  // Canonical mark applies to reviewed content, not to whatever came after.
  //
  // `opts.authorId` exists for exactly one caller: an accepted proposal, whose
  // version is authored by the agent that proposed it while the acting actor
  // is the person who accepted it (proposals.ts). Everywhere else author and
  // actor are the same, which is why it defaults to actorId.
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
        `UPDATE pages SET title = ?, owner_id = ?, approver_id = ?, effective_date = ?, review_date = ?,
         current_version = ?, status = ? WHERE id = ?`,
      )
      .run(
        content.title,
        content.fields.ownerId ?? null,
        content.fields.approverId ?? null,
        content.fields.effectiveDate ?? null,
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
    this.requireRole(actorId, row.collection_id as string, 'view');
    const rows = this.db
      .prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY number')
      .all(pageId) as Record<string, unknown>[];
    return rows.map((r) => this.toVersion(r));
  }

  getVersion(actorId: string, pageId: string, number: number): PageVersion {
    const row = this.pageRow(pageId);
    this.requireRole(actorId, row.collection_id as string, 'view');
    const v = this.db
      .prepare('SELECT * FROM page_versions WHERE page_id = ? AND number = ?')
      .get(pageId, number) as Record<string, unknown> | undefined;
    if (!v) throw new CanonError('not_found', `No version ${number} of page ${pageId}`);
    return this.toVersion(v);
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

  submitForReview(actorId: string, pageId: string): Page {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'edit');
    if (!TYPE_RULES[page.type].reviewed) {
      throw new CanonError('workflow', 'Notes publish directly and never carry the Canonical mark');
    }
    // Draft, or Needs Update. A page the freshness sweep flipped comes back to
    // Canonical through THIS workflow and no other (FEATURES.md §3): its owner
    // edits it and submits, the named approver accepts, and the Canonical mark
    // is granted by the same act that grants it to anything else. Inventing a
    // "re-certify" path would be inventing a second meaning for the mark.
    if (page.status !== 'draft' && page.status !== 'needs_update') {
      throw new CanonError('workflow', `Only a Draft or Needs Update page can be submitted for review (status: ${page.status})`);
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
    return this.getPage(actorId, pageId);
  }

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
    if (rules.requiresApprover && fields.approverId !== actorId) {
      throw new CanonError('forbidden', 'Only the named approver can grant the Canonical mark');
    }
    // A Plan names no approver; any holder of the approve role accepts it.
    const approved = this.writeVersion(
      actorId,
      page,
      {
        title: draft.title as string,
        body: draft.body as string,
        fields,
        note: input.note ?? 'Approved as Canonical',
      },
      { toStatus: 'canonical' },
    );
    this.audit(actorId, 'page.approve', {
      collectionId: page.collectionId,
      pageId,
      details: { version: approved.currentVersion },
    });
    this.notifier.draftApproved(actorId, pageId, draft.editor_id as string);
    return approved;
  }

  sendBack(actorId: string, pageId: string, input: { comment: string }): Page {
    const row = this.pageRow(pageId);
    const page = this.toPage(row);
    this.requireRole(actorId, page.collectionId, 'approve');
    if (page.status !== 'in_review') {
      throw new CanonError('workflow', `Only a page In Review can be sent back (status: ${page.status})`);
    }
    if (!input.comment?.trim()) {
      throw new CanonError('invalid', 'Sending a draft back requires a comment for the author');
    }
    this.db.prepare("UPDATE pages SET status = 'draft' WHERE id = ?").run(pageId);
    this.audit(actorId, 'page.send_back', {
      collectionId: page.collectionId,
      pageId,
      details: { comment: input.comment.trim() },
    });
    this.notifier.draftSentBack(actorId, pageId, input.comment.trim());
    return this.getPage(actorId, pageId);
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

  queryAudit(
    actorId: string,
    filter: { actorId?: string; action?: string; from?: string; to?: string; limit?: number } = {},
  ): AuditEvent[] {
    this.getActor(actorId);
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
    //      the actor it is about, and otherwise only an operator, which Core
    //      spells "admin on at least one collection" (SECURITY.md R5).
    //      These are the events with no collection to check and the most to
    //      give away: an `agent.session` event carries an agent's entire
    //      permitted-collections and permitted-sources lists, which is a map
    //      of the record's shape drawn for somebody holding no role in any of
    //      it, and an `answer.ask` event carries the question text, which is
    //      often the most sensitive sentence anybody types into Canon.
    //      Leaving them open was the residual of F2 and it is now closed.
    //
    // The operator stand-in is the same one notify.ts (`flushFor`) and
    // sources.ts (`requireSourceAdmin`) already use, deliberately: Core has no
    // organisation-level administrator role, and inventing a second definition
    // of "operator" here would be worse than reusing the one that exists. When
    // that role arrives, these three checks change together.
    //
    // This narrows for agents as well as people, because an agent is an actor.
    // It does not contradict REGISTRY-CONTRACT.md §4.2 — that rule is about
    // narrowing a cross-collection response to `permittedCollections`, and
    // agentauth's `narrow` still applies it on top of whatever survives here.
    // A limit that runs before another limit cannot widen it.
    const clauses: string[] = [
      `(CASE WHEN audit_events.collection_id IS NULL
              THEN audit_events.actor_id = ?
                   OR EXISTS (SELECT 1 FROM collection_members m
                               WHERE m.actor_id = ? AND m.role = 'admin')
              ELSE EXISTS (SELECT 1 FROM collection_members m
                            WHERE m.collection_id = audit_events.collection_id AND m.actor_id = ?)
         END)`,
    ];
    const params: (string | number)[] = [actorId, actorId, actorId];
    if (filter.actorId) {
      clauses.push('actor_id = ?');
      params.push(filter.actorId);
    }
    if (filter.action) {
      clauses.push('action = ?');
      params.push(filter.action);
    }
    if (filter.from) {
      clauses.push('at >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      clauses.push('at <= ?');
      params.push(filter.to);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    // Bound, and bound as a parameter rather than as text spliced into SQL: a
    // caller reaching the store directly with a non-numeric limit would
    // otherwise write into the statement.
    const asked = Number(filter.limit ?? 200);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 1000) : 200;
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      at: r.at as string,
      actorId: r.actor_id as string,
      actorKind: r.actor_kind as ActorKind,
      action: r.action as string,
      collectionId: (r.collection_id as string) ?? null,
      pageId: (r.page_id as string) ?? null,
      details: JSON.parse(r.details_json as string) as Record<string, unknown>,
    }));
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

  ask(actorId: string, request: AskRequest): Promise<AnswerResponse> {
    return this.answers.ask(actorId, request);
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

  // The CSV export answers the same filters as queryAudit and is bounded by
  // the same hard row cap (see AUDIT_CSV_MAX_ROWS in csv.ts).
  auditCsv(
    actorId: string,
    filter: { actorId?: string; action?: string; from?: string; to?: string; limit?: number } = {},
  ): RawResponse {
    const limit = Math.min(filter.limit ?? AUDIT_CSV_MAX_ROWS, AUDIT_CSV_MAX_ROWS);
    return auditCsvResponse(this.queryAudit(actorId, { ...filter, limit }));
  }

  runImport(actorId: string, input: ImportInput): ImportSummary {
    return new ImportService(this.db, this).run(actorId, input);
  }

  getImportRun(actorId: string, runId: string): ImportRunRecord {
    return new ImportService(this.db, this).getRun(actorId, runId);
  }

  listImportRuns(actorId: string): Omit<ImportRunRecord, 'items' | 'files'>[] {
    return new ImportService(this.db, this).listRuns(actorId);
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

  addReference(actorId: string, pageId: string, input: ReferenceInput): PageReference {
    return this.references.add(actorId, pageId, input);
  }

  listReferences(actorId: string, pageId: string): PageReference[] {
    return this.references.list(actorId, pageId);
  }

  removeReference(actorId: string, referenceId: string): void {
    this.references.remove(actorId, referenceId);
  }

  resolveReferences(actorId: string, pageId: string): Promise<ResolvedReference[]> {
    return this.references.resolveReferences(actorId, pageId);
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
      throw new CanonError('forbidden', 'Verifying the audit chain requires admin on a collection', {
        needed: 'admin' satisfies Role,
      });
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
