export const SCHEMA_VERSION = 2;

/**
 * Schema v2. Single SQLite file is the authority for every project.
 * Search is covered by an FTS5 trigram index so CJK substrings work; it is
 * created up front (cheap when idle) so we never need a migration to turn it on.
 * v2 adds the cross-session claim (claimed_by / claimed_at) so the console can
 * tell which conversation is currently working on an issue.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  root_path  TEXT NOT NULL,
  root_key   TEXT NOT NULL UNIQUE,
  aliases    TEXT NOT NULL DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  code           TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL DEFAULT 'defect',
  severity       TEXT NOT NULL DEFAULT 'major',
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open',
  parent_id      INTEGER REFERENCES items(id) ON DELETE SET NULL,
  depth          INTEGER NOT NULL DEFAULT 0,
  path           TEXT NOT NULL DEFAULT '',
  labels         TEXT NOT NULL DEFAULT '[]',
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT,
  closed_by      TEXT,
  closed_by_type TEXT,
  close_kind     TEXT,
  close_reason   TEXT,
  review_kind    TEXT,
  block_reason   TEXT,
  signoff_quote  TEXT,
  claimed_by     TEXT,
  claimed_at     TEXT,
  created_by     TEXT NOT NULL DEFAULT 'agent',
  created_session TEXT,
  UNIQUE(project_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_items_project_status ON items(project_id, status);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_path ON items(path);

CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_item  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  to_item    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(from_item, to_item, type)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_item);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_item);

CREATE TABLE IF NOT EXISTS evidence (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL DEFAULT 'other',
  ref      TEXT NOT NULL DEFAULT '',
  note     TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL DEFAULT 'agent',
  added_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_item ON evidence(item_id);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id    INTEGER,
  session_id TEXT,
  actor      TEXT NOT NULL DEFAULT 'agent',
  action     TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id, id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id);

CREATE TABLE IF NOT EXISTS ops (
  key    TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  at     TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  code,
  title,
  body,
  content='items',
  content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, code, title, body) VALUES (new.id, new.code, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, code, title, body) VALUES ('delete', old.id, old.code, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, code, title, body) VALUES ('delete', old.id, old.code, old.title, old.body);
  INSERT INTO items_fts(rowid, code, title, body) VALUES (new.id, new.code, new.title, new.body);
END;
`;

/** Columns added after v1; applied to older databases by migrate(). */
export const ADDED_COLUMNS: Array<{ table: string; column: string; type: string }> = [
  { table: 'items', column: 'claimed_by', type: 'TEXT' },
  { table: 'items', column: 'claimed_at', type: 'TEXT' },
];

/** Full-text search needs at least 3 characters with the trigram tokenizer. */
export const FTS_MIN_QUERY_LENGTH = 3;
