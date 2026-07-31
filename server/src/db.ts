import { DatabaseSync } from 'node:sqlite';
import { ensureAuditChain, registerAuditChainFunction } from './auditchain.js';
import { COMMENTS_SCHEMA } from './comments.js';
import { EMBEDDINGS_SCHEMA } from './embeddings.js';
import { ensurePageFreshnessSchema } from './freshness.js';
import { IMPORTS_SCHEMA } from './import.js';
import { NOTIFICATIONS_SCHEMA } from './notify.js';
import { ORG_SCHEMA } from './orgrole.js';
import { PROPOSALS_SCHEMA } from './proposals.js';
import { QUERIES_SCHEMA } from './queries.js';
import { Migration, runMigrations } from './migrate.js';
import { REFERENCES_SCHEMA } from './references.js';
import { SOURCES_SCHEMA } from './sources.js';

// Connection settings, not schema. They are applied on every open and they are
// deliberately outside the migration runner: SQLite refuses to change journal
// mode inside a transaction, and every migration runs in one.
const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
`;

// Storage separates by lifecycle (DATA-BACKBONE.md §4): the current record
// (actors, collections, members, pages, drafts), immutable history
// (page_versions, audit_events), and derived indexes, which are rebuildable
// and live elsewhere. History is append-only and that is enforced here, at
// the storage layer, not just in application code.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS actors (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  name         TEXT NOT NULL,
  email        TEXT,
  registry_ref TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  restricted  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS collection_members (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  actor_id      TEXT NOT NULL REFERENCES actors(id),
  role          TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit', 'approve', 'admin')),
  PRIMARY KEY (collection_id, actor_id)
);

CREATE TABLE IF NOT EXISTS pages (
  id              TEXT PRIMARY KEY,
  collection_id   TEXT NOT NULL REFERENCES collections(id),
  parent_id       TEXT REFERENCES pages(id),
  position        INTEGER NOT NULL DEFAULT 0,
  type            TEXT NOT NULL CHECK (type IN ('policy', 'spec', 'plan', 'note')),
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'in_review', 'canonical', 'needs_update', 'archived')),
  owner_id        TEXT REFERENCES actors(id),
  approver_id     TEXT REFERENCES actors(id),
  effective_date  TEXT,
  review_date     TEXT,
  current_version INTEGER,
  created_by      TEXT NOT NULL REFERENCES actors(id),
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pages_collection ON pages(collection_id);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);

CREATE TABLE IF NOT EXISTS page_versions (
  page_id     TEXT NOT NULL REFERENCES pages(id),
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  author_id   TEXT NOT NULL REFERENCES actors(id),
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (page_id, number)
);

CREATE TABLE IF NOT EXISTS drafts (
  page_id      TEXT PRIMARY KEY REFERENCES pages(id),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  fields_json  TEXT NOT NULL,
  editor_id    TEXT NOT NULL REFERENCES actors(id),
  base_version INTEGER,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            TEXT NOT NULL,
  actor_id      TEXT NOT NULL,
  actor_kind    TEXT NOT NULL,
  action        TEXT NOT NULL,
  collection_id TEXT,
  page_id       TEXT,
  details_json  TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);

CREATE TRIGGER IF NOT EXISTS page_versions_append_only_update
BEFORE UPDATE ON page_versions
BEGIN SELECT RAISE(ABORT, 'page_versions is append-only'); END;

CREATE TRIGGER IF NOT EXISTS page_versions_append_only_delete
BEFORE DELETE ON page_versions
BEGIN SELECT RAISE(ABORT, 'page_versions is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
`;

/**
 * The bootstrap, exactly as it stood before migrations existed, and now the
 * body of migration 1. Every statement in it is `CREATE … IF NOT EXISTS`, so
 * running it on a database that already has the tables does nothing — which is
 * what lets a fresh database and one written by the previous build converge on
 * the same version 1 without either being special-cased.
 *
 * A module's DDL still lives beside its logic in a `_SCHEMA` constant; adding
 * one to this list is how a purely additive table arrives. A change to an
 * existing table is a numbered migration in `MIGRATIONS` below and never an
 * edit here — see OPERATIONS.md "Adding a table".
 */
export function applyBaselineSchema(db: DatabaseSync): void {
  db.exec(SCHEMA);
  db.exec(COMMENTS_SCHEMA); // comments (Epic C, M2); DDL lives with its logic in comments.ts
  db.exec(NOTIFICATIONS_SCHEMA); // notifications outbox (Epic C, M2); DDL in notify.ts
  db.exec(EMBEDDINGS_SCHEMA); // derived embeddings (Epic D, M3); DDL in embeddings.ts
  db.exec(IMPORTS_SCHEMA); // import runs and their per-file outcomes (Epic E, M4); DDL in import.ts
  db.exec(SOURCES_SCHEMA); // federated sources (DATA-BACKBONE.md §6); DDL in sources.ts
  db.exec(REFERENCES_SCHEMA); // reference fields and their labelled cache; DDL in references.ts
  db.exec(PROPOSALS_SCHEMA); // agent proposals (FEATURES.md §5, Next tier); DDL in proposals.ts
  db.exec(QUERIES_SCHEMA); // saved structured queries (Next tier); DDL in queries.ts
  db.exec(ORG_SCHEMA); // org roles, and hand-granted vs group-granted membership; DDL in orgrole.ts
  // Freshness (Next tier) added `review_date` and the `needs_update` status to
  // pages. A record created by an earlier build is brought up to date here, as
  // notify.ts does for its delivery columns; a fresh database already matches.
  ensurePageFreshnessSchema(db);
}

/**
 * The migration list. Append only; never reorder, never renumber, never edit a
 * released migration — a partner's database has already run it, and the version
 * number is the only record that it did.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline',
    // Owns its transaction because the freshness rebuild it folds in needs
    // foreign keys off around a BEGIN of its own; re-applied on every open
    // because it is idempotent by construction. See migrate.ts on `always`.
    ownTransaction: true,
    always: true,
    up: applyBaselineSchema,
  },
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // Before any schema and long before any write: the audit chain's hash
  // function is called by a trigger on `audit_events`, so a connection that
  // could insert an event without it would insert an unchained one. Registering
  // first means no such connection ever exists. See auditchain.ts.
  registerAuditChainFunction(db);
  db.exec(PRAGMAS);
  runMigrations(db, MIGRATIONS);
  // The audit hash chain (FEATURES.md §7, "tamper-evident"). Creates the link
  // table and the AFTER INSERT trigger that writes a link per event, and — on a
  // record that already holds events — records that the chain starts at the
  // current head rather than pretending to cover what came before. What the
  // chain does and does not prove is written out at the top of auditchain.ts.
  // After the migrations, because it triggers on a table they create.
  ensureAuditChain(db);
  return db;
}
