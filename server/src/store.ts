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
import { Comment, CommentAnchor, CommentService } from './comments.js';
import { Notification, NotificationTransport, Notifier } from './notify.js';

export interface TreeNode extends Page {
  children: TreeNode[];
}

function now(): string {
  return new Date().toISOString();
}

export class CanonStore {
  // Comments and notifications (Epic C, M2) live in comments.ts and
  // notify.ts; the store carries thin delegates so its surface stays
  // uniform (actorId first). The transport defaults to the dev transport.
  private readonly notifier: Notifier;
  private readonly commentService: CommentService;

  constructor(private readonly db: DatabaseSync, transport?: NotificationTransport) {
    this.notifier = new Notifier(db, this, transport);
    this.commentService = new CommentService(db, this, this.notifier);
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
  private writeVersion(
    actorId: string,
    page: Page,
    content: { title: string; body: string; fields: PageFields; note: string | null },
    opts: { toStatus?: Page['status'] } = {},
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
      .run(page.id, next, content.title, content.body, JSON.stringify(content.fields), actorId, content.note, at);
    this.db
      .prepare(
        `UPDATE pages SET title = ?, owner_id = ?, approver_id = ?, effective_date = ?,
         current_version = ?, status = ? WHERE id = ?`,
      )
      .run(
        content.title,
        content.fields.ownerId ?? null,
        content.fields.approverId ?? null,
        content.fields.effectiveDate ?? null,
        next,
        opts.toStatus ?? 'draft',
        page.id,
      );
    this.db.prepare('DELETE FROM drafts WHERE page_id = ?').run(page.id);
    this.audit(actorId, 'page.publish', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: { version: next, status: opts.toStatus ?? 'draft' },
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
    if (page.status !== 'draft') {
      throw new CanonError('workflow', `Only a Draft page can be submitted for review (status: ${page.status})`);
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
    this.getActor(actorId); // audit access control tightens with the admin surface; presence check for now
    const clauses: string[] = [];
    const params: (string | number)[] = [];
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
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(filter.limit ?? 200, 1000);
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${where} ORDER BY id DESC LIMIT ${limit}`)
      .all(...params) as Record<string, unknown>[];
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

  createComment(actorId: string, pageId: string, input: { body: string; anchor?: Partial<CommentAnchor> | null }): Comment {
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
}
