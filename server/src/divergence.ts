import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Actor, CanonError, Role, ROLE_RANK } from './model.js';
import type { Notifier } from './notify.js';
import type { ReferenceRole } from './references.js';

// Contradiction, made visible and never resolved (DATA-BACKBONE.md §7).
//
// Federation brings in facts Canon does not own, and two systems can answer
// the same question differently. This file is the machinery that lets Canon
// NOTICE that without ever deciding between them. The document is unusually
// blunt about what that means, and every rule below is one of its sentences:
//
//   "Canon surfaces contradiction. It does not resolve it. There is no
//    averaging, no last-write-wins, no preferring the fresher answer, no
//    confidence score that quietly ranks one system above another."
//
// THE ONE LEGITIMATE PRECEDENCE IS OWNERSHIP, AND IT IS A MODELLING DECISION
//
// §7: "authority belongs to a field, not to a source." A reference declares
// which system is authoritative for that fact (`role: 'authority'`), and any
// other source answering the same question is CORROBORATION. So:
//
//   * the authority's value is what displays, always. A corroborating source
//     never replaces it, never overrides it when fresher, and never blanks it
//     when it disagrees. "No rule that the fresher value wins — freshness is
//     not authority, and a stale answer from the system that owns a fact still
//     beats a fresh one from a system that does not."
//   * a corroborating source's disagreement "is a signal about the systems,
//     never a vote about the value."
//
// Where two systems genuinely both own their answer there is no authority to
// name, and Canon must not invent one — that is a definitions problem, settled
// by a person in the page's prose. Nothing here tries to settle it.
//
// A DIVERGENCE IS A RECORD, NOT A DECISION
//
// When a corroborating source disagrees with its authority, Canon writes a
// Divergence: which reference, which sources, what each said, and when it was
// observed. The authoritative value keeps displaying, the page shows that a
// divergence exists, the page's owner is told through the same outbox that
// carries review requests, and the whole thing lands in the audit log.
//
// Closing one is a person's judgement with a stated reason — "the copy was
// wrong and has been corrected upstream", "the definitions differ and here is
// why", "this source should not have been corroborating this field" — and it
// STAYS closed. §7's last line: "No silent closure of a divergence because two
// systems drifted back into agreement." A closed pair that diverges again is a
// NEW divergence, and the old one remains as history. That is why nothing in
// this file ever writes `state = 'closed'` except `close()`.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No automatic merge. No per-source trust score. No `displayValue` that picks
// a winner. No check of prose against a value — §7 rules that out in terms
// ("Canon cannot check this by parsing, and will not try"), and routes it to a
// proposal, which proposals.ts already carries.

/**
 * Purely additive: a new table, `CREATE TABLE IF NOT EXISTS`, so it arrives on
 * an existing partner's database through `applyBaselineSchema` with no version
 * bump (OPERATIONS.md, "Adding a table", rule 2). The `role` column this
 * feature adds to `page_references` is the other half, and that one IS a
 * numbered migration, because it changes an existing table (rule 3).
 *
 * On the deliberate absence of foreign keys to `page_references`, `sources`
 * and `pages`: a divergence OUTLIVES the reference that produced it, exactly
 * as an audit event outlives its subject. A reference can be removed and its
 * source then deregistered; the observation that two systems once disagreed is
 * not thereby untrue, and a foreign key would either block the removal forever
 * or delete the record of it. `audit_events` holds ids the same way and for
 * the same reason. `closed_by` does carry one, because actors are never
 * deleted and the closer's identity is the point of the row.
 */
export const DIVERGENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS divergences (
  id                  TEXT PRIMARY KEY,
  reference_id        TEXT NOT NULL,
  page_id             TEXT NOT NULL,
  authority_source_id TEXT NOT NULL,
  authority_value     TEXT NOT NULL,
  other_source_id     TEXT NOT NULL,
  other_value         TEXT NOT NULL,
  observed_at         TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  closed_by           TEXT REFERENCES actors(id),
  closed_at           TEXT,
  reason              TEXT
);

CREATE INDEX IF NOT EXISTS idx_divergences_page ON divergences(page_id, state);
CREATE INDEX IF NOT EXISTS idx_divergences_state ON divergences(state, observed_at);

-- One row per disagreeing pair, while it is open. A page read a thousand times
-- must not write a thousand rows, so an open divergence for the same pair is
-- UPDATED with the latest observation. The pair is the corroborating reference
-- plus the authority it was measured against: change which source is
-- authoritative and that is a different pair, and honestly a different
-- disagreement. Closed rows are outside the index, which is what lets the same
-- pair diverge again later as a NEW divergence with the old one intact.
CREATE UNIQUE INDEX IF NOT EXISTS idx_divergences_open_pair
  ON divergences(reference_id, authority_source_id) WHERE state = 'open';
`;

export type DivergenceState = 'open' | 'closed';

/** DATA-BACKBONE.md §7, "The shapes", verbatim. */
export interface Divergence {
  id: string;
  referenceId: string;
  pageId: string;
  authoritySourceId: string;
  authorityValue: unknown;
  otherSourceId: string;
  otherValue: unknown;
  observedAt: string;
  state: DivergenceState;
  closedBy?: string;
  closedAt?: string;
  reason?: string;
}

/**
 * The marker a resolved reference carries so a page can show a disagreement
 * without a second call. Present only when this reference takes part in at
 * least one OPEN divergence; absent otherwise, exactly as `error` is.
 *
 * `side` is this reference's part in it: the authority whose value displays, or
 * the corroborating source that disagrees with it. An authority can be in more
 * than one at once — two corroborating systems can both have drifted — which
 * is why `open` is a list rather than a single record.
 */
export interface ReferenceDivergenceMarker {
  side: ReferenceRole;
  open: Divergence[];
}

/**
 * What the reference layer hands over after a page's references resolve.
 * `ResolvedReference` satisfies this structurally, so references.ts passes its
 * own results straight through and this module never imports its class.
 */
export interface ObservedReference {
  referenceId: string;
  sourceId: string;
  sourceName: string;
  role: ReferenceRole;
  selector: string;
  key: string;
  value: unknown;
  resolvedAt: string | null;
  stale: boolean;
  error?: string;
}

// The minimal slice of CanonStore this service needs; CanonStore satisfies it.
export interface DivergenceHost {
  getActor(id: string): Actor;
  roleOf(actorId: string, collectionId: string): Role | null;
}

export interface DivergenceFilter {
  state?: DivergenceState;
  collectionId?: string;
  /**
   * Only divergences on pages owned by this actor. The owner is the person §7
   * already notifies when one opens, so "the record disagrees with itself on a
   * page you are accountable for" is a question the record can answer, and
   * USER-TESTING.md T2.1 is what happens when nothing asks it: a page owner
   * learned about a contradiction against her own Canonical policy by accident,
   * from a list view she had opened for another reason. Applied in the SELECT
   * alongside the membership join, never after it.
   */
  ownerId?: string;
  limit?: number;
}

export const DEFAULT_DIVERGENCE_LIMIT = 200;
export const MAX_DIVERGENCE_LIMIT = 1000;

function now(): string {
  return new Date().toISOString();
}

// ---- when two systems are saying the same thing -------------------------
//
// THE DECISION, AND WHY IT IS THIS AND NOT MORE.
//
// A value crosses a JSON body, a CSV export, a SQL numeric column and a form
// field on its way here, and the same fact arrives spelled differently: 1500,
// "1500", 1500.0. Treating those as three answers would fill the record with
// contradictions that exist only in the wire format, and an organisation that
// learns to ignore divergences has lost the feature.
//
// So exactly one normalisation is applied, and it is numbers:
//
//   * if BOTH sides parse as a finite decimal number — a JSON number, or a
//     string that is nothing but a number, optionally signed, with an optional
//     fractional part or exponent, and surrounding whitespace — they are
//     compared numerically. 1500 == "1500" == 1500.0 == " 1.5e3 ".
//
// And nothing else, because everything else discards meaning that might be the
// disagreement:
//
//   * "1,500" and "1 500" are NOT parsed. A thousands separator is
//     locale-dependent — in half of Europe that comma is a decimal point — so
//     stripping it would silently agree two values that differ by a factor of
//     a thousand. A source that answers with formatted text is answering with
//     text, and the honest reading is "these are not the same string".
//   * "$1500", "1500 USD", "1500ms" are NOT parsed. The unit is part of the
//     fact; discarding it is how a deductible in dollars agrees with one in
//     euros.
//   * strings are compared EXACTLY — no trimming, no case folding. "Active"
//     and "active" may well be the same fact, but they may equally be two
//     different codes in two systems, and Canon does not get to guess. A false
//     agreement hides a contradiction, which is the one failure §7 exists to
//     prevent; a false disagreement is visible, attributed, and closable by a
//     person with a reason.
//   * `true` and "true" are NOT equated, for the same reason.
//   * objects and arrays are compared structurally, with object keys sorted, so
//     that key ORDER — which JSON does not define as meaningful — is not itself
//     a contradiction. Array order IS kept: a list is ordered until someone
//     says otherwise.
//
// The asymmetry is deliberate. Where the rule is unsure it says "these differ",
// and a person closes the divergence with "these are the same, here is why" —
// which is a sentence the record keeps.

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A finite number, or a string that is nothing but one. Otherwise null. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DECIMAL.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Are these two resolved values the same fact? See the essay above. */
export function sameFact(a: unknown, b: unknown): boolean {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb;
  // One side numeric and the other not is a genuine difference in what was
  // said, and is reported as one. 1500 versus "about 1500" is a disagreement.
  if (na !== null || nb !== null) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  return canonical(a) === canonical(b);
}

/**
 * Is this resolution something a contradiction may be built on? Only a value
 * that came back, fresh, from a source this asker was allowed to reach.
 *
 * §7 turns on two systems SAYING different things. A source that was down, a
 * value past its freshness window, and a reference the Registry withheld are
 * all cases where one side said nothing at all — and an unknown value is not a
 * disagreeing value. Opening a divergence on one would turn every source
 * outage into a wave of false contradictions landing in an owner's inbox,
 * which is precisely the "confident number with no way to ask where it came
 * from" that §7 forbids, wearing the opposite costume.
 */
function usable(reference: ObservedReference): boolean {
  return !reference.error && !reference.stale && reference.resolvedAt !== null;
}

export class DivergenceService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly host: DivergenceHost,
    private readonly notifier: Notifier,
  ) {}

  // ---- detection -------------------------------------------------------

  /**
   * Called once, at the end of a page's reference resolution, with everything
   * that came back. Compares each corroborating value against its authority's,
   * records what disagrees, and returns the markers to hang on the resolved
   * references — keyed by reference id.
   *
   * It NEVER throws, and the try/catch is the enforcement rather than a hope.
   * Resolution already refuses to fail a page because a source is down; failing
   * one because the disagreement bookkeeping hiccupped would be strictly worse,
   * and a reader would lose the page as well as the warning. The failure is
   * logged where an operator can find it — loudly, because an unrecorded
   * contradiction is a real loss, not a tidy degradation.
   */
  observe(actor: Actor, pageId: string, resolved: ObservedReference[]): Map<string, ReferenceDivergenceMarker> {
    try {
      return this.detect(actor, pageId, resolved);
    } catch (err) {
      console.error(`[divergence] page ${pageId}: could not record or read divergences`, err);
      return new Map();
    }
  }

  private detect(actor: Actor, pageId: string, resolved: ObservedReference[]): Map<string, ReferenceDivergenceMarker> {
    const markers = new Map<string, ReferenceDivergenceMarker>();
    if (resolved.length === 0) return markers;
    const page = this.pageRow(pageId);
    if (!page) return markers;

    // One fact = one (selector, key) on one page. That is the same triple the
    // authority rule in references.ts is unique over, which is what makes
    // "at most one authority per fact" true here rather than assumed.
    const groups = new Map<string, ObservedReference[]>();
    for (const reference of resolved) {
      const fact = `${reference.selector} ${reference.key}`;
      const group = groups.get(fact);
      if (group) group.push(reference);
      else groups.set(fact, [reference]);
    }

    for (const group of groups.values()) {
      const authority = group.find((r) => r.role === 'authority');
      const corroborating = group.filter((r) => r.role === 'corroborating');
      if (!authority || corroborating.length === 0) continue;
      for (const other of corroborating) {
        if (!usable(authority) || !usable(other)) continue;
        if (sameFact(authority.value, other.value)) continue;
        this.record(actor, page, authority, other);
      }
    }

    // Read AFTER recording, so a divergence opened by this very resolution is
    // on the payload the reader is about to see. Open only: a closed divergence
    // is history, and history belongs on the divergence endpoints rather than
    // on a live field.
    const open = this.openForPage(pageId);
    if (open.length === 0) return markers;
    const byReference = new Map<string, Divergence[]>();
    for (const divergence of open) {
      const list = byReference.get(divergence.referenceId);
      if (list) list.push(divergence);
      else byReference.set(divergence.referenceId, [divergence]);
    }
    for (const group of groups.values()) {
      const authority = group.find((r) => r.role === 'authority');
      const forAuthority: Divergence[] = [];
      for (const other of group) {
        if (other.role !== 'corroborating') continue;
        const mine = byReference.get(other.referenceId);
        if (!mine || mine.length === 0) continue;
        markers.set(other.referenceId, { side: 'corroborating', open: mine });
        forAuthority.push(...mine);
      }
      if (authority && forAuthority.length > 0) {
        markers.set(authority.referenceId, { side: 'authority', open: forAuthority });
      }
    }
    return markers;
  }

  // One disagreeing pair, opened or refreshed.
  private record(actor: Actor, page: PageRow, authority: ObservedReference, other: ObservedReference): void {
    const observedAt = now();
    const existing = this.db
      .prepare(
        `SELECT id FROM divergences
          WHERE reference_id = ? AND authority_source_id = ? AND state = 'open'`,
      )
      .get(other.referenceId, authority.sourceId) as { id: string } | undefined;

    if (existing) {
      // The same pair, still disagreeing: carry the latest observation and
      // stop. No second row, no second notification, and NO AUDIT EVENT —
      // a page read a thousand times would otherwise write a thousand of
      // each, and "the systems still disagree" is not news. `divergence.open`
      // is the event, and it happened once, below.
      this.db
        .prepare(
          `UPDATE divergences
              SET authority_value = ?, other_value = ?, other_source_id = ?, observed_at = ?
            WHERE id = ? AND state = 'open'`,
        )
        .run(
          JSON.stringify(authority.value ?? null),
          JSON.stringify(other.value ?? null),
          other.sourceId,
          observedAt,
          existing.id,
        );
      return;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO divergences
           (id, reference_id, page_id, authority_source_id, authority_value,
            other_source_id, other_value, observed_at, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(
        id,
        other.referenceId,
        page.id,
        authority.sourceId,
        JSON.stringify(authority.value ?? null),
        other.sourceId,
        JSON.stringify(other.value ?? null),
        observedAt,
      );

    this.audit(actor, 'divergence.open', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: {
        divergenceId: id,
        referenceId: other.referenceId,
        selector: other.selector,
        key: other.key,
        authoritySourceId: authority.sourceId,
        authoritySourceName: authority.sourceName,
        authorityValue: authority.value,
        otherSourceId: other.sourceId,
        otherSourceName: other.sourceName,
        otherValue: other.value,
        observedAt,
      },
    });

    // "The page's owner is notified through the same outbox that carries
    // review requests" (§7). Straight to `send`, as the freshness sweep does
    // and for the same reason: this is the systems speaking, not a colleague,
    // so an owner who read their own page is still told. A page with no owner
    // notifies nobody — the divergence is still recorded, and shows up in the
    // listings and on the page.
    if (page.ownerId) {
      this.notifier.send(page.ownerId, {
        kind: 'divergence_opened',
        subject: `Sources disagree on "${page.title}"`,
        body:
          `${authority.sourceName} is the authority for ${other.selector}/${other.key} and says ` +
          `${display(authority.value)}; ${other.sourceName} says ${display(other.value)}. ` +
          'The authoritative value is what the page shows — Canon does not choose between them. ' +
          'Close the divergence with a reason once you have settled what happened.',
        link: `/pages/${page.id}#divergence-${id}`,
      });
    }
  }

  // ---- closing: a decision the record keeps ----------------------------

  /**
   * Close a divergence, with a reason, forever.
   *
   * A PERSON'S ACT, refused to agents twice over — here, and by absence from
   * agentauth.ts's route table — on exactly the precedent proposals.ts set for
   * accept and reject. FEATURES.md §5: "People stay the approvers; agents do
   * the tedious watching." Closing a divergence is a claim about two external
   * systems that Canon cannot check and will not check: *the copy was wrong*,
   * *the definitions differ*, *this source should not be corroborating this
   * field*. Every one of those is a judgement somebody has to be accountable
   * for, and the Registry's vocabulary (read, comment, write) cannot express
   * "may settle a contradiction". Default no. An agent that spots the cause
   * has the path FEATURES.md gives it: raise a proposal, and a person settles
   * it — which is §7's own answer for the prose-versus-value case.
   *
   * The reason is REQUIRED. §7 names closing as "a decision the record keeps,
   * not a flag that silently clears": a closure with no stated reason is
   * exactly the flag, and it would leave the next reader unable to tell a
   * settled contradiction from a dismissed one.
   */
  close(actorId: string, id: string, input: { reason?: string } = {}): Divergence {
    const actor = this.requirePerson(actorId);
    const divergence = this.row(id);
    const page = this.pageRow(divergence.pageId);
    if (!page) throw new CanonError('not_found', `No such page: ${divergence.pageId}`);
    // `edit` on the collection, the same bar proposals.ts sets for accepting
    // or rejecting one: settling a disagreement about what the page displays
    // is work on the page, done by someone entitled to do work on the page.
    this.requireRole(actorId, page.collectionId, 'edit');

    const reason = input.reason?.trim();
    if (!reason) {
      throw new CanonError(
        'invalid',
        'Closing a divergence requires a reason: what was actually true, and why the two systems differed ' +
          '(a closure without one is a flag that cleared, not a decision the record keeps)',
      );
    }
    if (divergence.state !== 'open') {
      throw new CanonError('workflow', 'This divergence is already closed', {
        divergenceId: divergence.id,
        closedBy: divergence.closedBy,
        closedAt: divergence.closedAt,
      });
    }

    const closedAt = now();
    // Conditional on it still being open, so two people closing at once
    // produce one closure and one refusal rather than two overlapping ones.
    const changed = this.db
      .prepare(
        `UPDATE divergences SET state = 'closed', closed_by = ?, closed_at = ?, reason = ?
          WHERE id = ? AND state = 'open'`,
      )
      .run(actorId, closedAt, reason, id);
    if (Number(changed.changes) !== 1) {
      throw new CanonError('workflow', 'This divergence is already closed', { divergenceId: id });
    }

    this.audit(actor, 'divergence.close', {
      collectionId: page.collectionId,
      pageId: page.id,
      details: {
        divergenceId: id,
        referenceId: divergence.referenceId,
        authoritySourceId: divergence.authoritySourceId,
        authorityValue: divergence.authorityValue,
        otherSourceId: divergence.otherSourceId,
        otherValue: divergence.otherValue,
        observedAt: divergence.observedAt,
        reason,
        closedAt,
      },
    });
    return this.row(id);
  }

  // ---- reading ---------------------------------------------------------

  /** This page's divergences, newest observation first. `view` on its collection. */
  listForPage(actorId: string, pageId: string, filter: { state?: DivergenceState } = {}): Divergence[] {
    const page = this.pageRow(pageId);
    if (!page) throw new CanonError('not_found', `No such page: ${pageId}`);
    this.requireRole(actorId, page.collectionId, 'view');
    const state = this.validState(filter.state);
    const rows = this.db
      .prepare(
        `SELECT * FROM divergences
          WHERE page_id = ? AND (? IS NULL OR state = ?)
          ORDER BY observed_at DESC, rowid DESC`,
      )
      .all(pageId, state, state) as Record<string, unknown>[];
    return rows.map(toDivergence);
  }

  /**
   * Divergences across the record. A SPANNING read, so it is filtered to the
   * collections the asker belongs to rather than refused because the record
   * holds one they cannot see — the treatment search and the query surface
   * already give, and the one REGISTRY-CONTRACT.md §4.2 requires for an agent.
   * Naming a collection the asker cannot see therefore returns nothing, which
   * is the same answer as a collection with no divergences in it.
   */
  list(actorId: string, filter: DivergenceFilter = {}): Divergence[] {
    this.host.getActor(actorId);
    const state = this.validState(filter.state);
    const collectionId = filter.collectionId ?? null;
    const ownerId = filter.ownerId ?? null;
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_DIVERGENCE_LIMIT, 1), MAX_DIVERGENCE_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT d.* FROM divergences d
           JOIN pages p ON p.id = d.page_id
           JOIN collection_members m ON m.collection_id = p.collection_id AND m.actor_id = ?
          WHERE (? IS NULL OR d.state = ?) AND (? IS NULL OR p.collection_id = ?)
            AND (? IS NULL OR p.owner_id = ?)
          ORDER BY d.observed_at DESC, d.rowid DESC
          LIMIT ?`,
      )
      .all(actorId, state, state, collectionId, collectionId, ownerId, ownerId, limit) as Record<string, unknown>[];
    return rows.map(toDivergence);
  }

  /** One divergence, to anyone who may view the page it is on. */
  get(actorId: string, id: string): Divergence {
    const divergence = this.row(id);
    const page = this.pageRow(divergence.pageId);
    if (!page) throw new CanonError('not_found', `No such divergence: ${id}`);
    this.requireRole(actorId, page.collectionId, 'view');
    return divergence;
  }

  // ---- internals -------------------------------------------------------

  private openForPage(pageId: string): Divergence[] {
    const rows = this.db
      .prepare("SELECT * FROM divergences WHERE page_id = ? AND state = 'open' ORDER BY observed_at, rowid")
      .all(pageId) as Record<string, unknown>[];
    return rows.map(toDivergence);
  }

  private row(id: string): Divergence {
    const row = this.db.prepare('SELECT * FROM divergences WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new CanonError('not_found', `No such divergence: ${id}`);
    return toDivergence(row);
  }

  private pageRow(id: string): PageRow | null {
    const row = this.db.prepare('SELECT id, collection_id, title, owner_id FROM pages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      title: row.title as string,
      ownerId: (row.owner_id as string) ?? null,
    };
  }

  private validState(state: DivergenceState | undefined): DivergenceState | null {
    if (state === undefined) return null;
    if (state !== 'open' && state !== 'closed') {
      throw new CanonError('invalid', `A divergence is 'open' or 'closed', not '${String(state)}'`, {
        supported: ['open', 'closed'],
      });
    }
    return state;
  }

  private requirePerson(actorId: string): Actor {
    const actor = this.host.getActor(actorId);
    if (actor.kind === 'agent') {
      throw new CanonError(
        'forbidden',
        'Only a person can close a divergence: an agent may notice that two systems disagree, but deciding ' +
          'what was true is a person’s act',
        { reason: 'closing_is_a_persons_act', actorKind: actor.kind },
      );
    }
    return actor;
  }

  private requireRole(actorId: string, collectionId: string, needed: Role): void {
    const role = this.host.roleOf(actorId, collectionId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[needed]) {
      throw new CanonError('forbidden', `Requires ${needed} access to this collection`, {
        collectionId,
        needed,
        held: role,
      });
    }
  }

  private audit(
    actor: Actor,
    action: string,
    ctx: { collectionId?: string; pageId?: string; details?: Record<string, unknown> } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (at, actor_id, actor_kind, action, collection_id, page_id, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now(),
        actor.id,
        actor.kind,
        action,
        ctx.collectionId ?? null,
        ctx.pageId ?? null,
        JSON.stringify(ctx.details ?? {}),
      );
  }
}

interface PageRow {
  id: string;
  collectionId: string;
  title: string;
  ownerId: string | null;
}

function toDivergence(row: Record<string, unknown>): Divergence {
  const state = row.state as DivergenceState;
  const divergence: Divergence = {
    id: row.id as string,
    referenceId: row.reference_id as string,
    pageId: row.page_id as string,
    authoritySourceId: row.authority_source_id as string,
    authorityValue: JSON.parse(row.authority_value as string) as unknown,
    otherSourceId: row.other_source_id as string,
    otherValue: JSON.parse(row.other_value as string) as unknown,
    observedAt: row.observed_at as string,
    state,
  };
  // Present only on a closed one, exactly as §7's shape has them: `closedBy?`,
  // `closedAt?`, `reason?`. An open divergence carries no empty decision.
  if (row.closed_by) divergence.closedBy = row.closed_by as string;
  if (row.closed_at) divergence.closedAt = row.closed_at as string;
  if (row.reason) divergence.reason = row.reason as string;
  return divergence;
}

// For the notification's prose. A number reads as itself, a string in quotes,
// anything else as its JSON — and all of it capped, because a source that
// answers with a whole document should not send an owner a whole document.
function display(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value ?? null) ?? 'null';
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
