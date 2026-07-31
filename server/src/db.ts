import { DatabaseSync } from 'node:sqlite';
import { COMMENTS_SCHEMA } from './comments.js';
import { IMPORTS_SCHEMA } from './import.js';
import { NOTIFICATIONS_SCHEMA } from './notify.js';

// Storage separates by lifecycle (DATA-BACKBONE.md §4): the current record
// (actors, collections, members, pages, drafts), immutable history
// (page_versions, audit_events), and derived indexes, which are rebuildable
// and live elsewhere. History is append-only and that is enforced here, at
// the storage layer, not just in application code.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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
                  CHECK (status IN ('draft', 'in_review', 'canonical', 'archived')),
  owner_id        TEXT REFERENCES actors(id),
  approver_id     TEXT REFERENCES actors(id),
  effective_date  TEXT,
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

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec(COMMENTS_SCHEMA); // comments (Epic C, M2); DDL lives with its logic in comments.ts
  db.exec(NOTIFICATIONS_SCHEMA); // notifications outbox (Epic C, M2); DDL in notify.ts
  db.exec(IMPORTS_SCHEMA); // import runs and their per-file outcomes (Epic E, M4); DDL in import.ts
  return db;
}
