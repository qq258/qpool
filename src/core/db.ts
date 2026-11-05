import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ADDED_COLUMNS, SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';
import { QpoolError } from './errors.ts';

export type Db = DatabaseSync;

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  configure(db);
  migrate(db);
  return db;
}

function configure(db: Db): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;

  if (!row) {
    db.exec(SCHEMA_SQL);
    ensureAddedColumns(db);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
    return;
  }

  const current = Number.parseInt(row.value, 10);
  if (current > SCHEMA_VERSION) {
    throw new QpoolError(
      'INTERNAL',
      `database schema v${current} is newer than this program (v${SCHEMA_VERSION}); update qpool`,
    );
  }
  if (current < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL);
    ensureAddedColumns(db);
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION));
  }
}

/**
 * Column migrations are additive and idempotent, so they are applied by name
 * rather than by version number: a database restored from a backup never ends up
 * with a table that is missing a column the code reads.
 */
function ensureAddedColumns(db: Db): void {
  for (const entry of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info('${entry.table}')`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === entry.column)) continue;
    db.exec(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.type}`);
  }
}

const inTransaction = new WeakSet<object>();

/** Run `fn` inside an IMMEDIATE transaction. Nested calls reuse the outer one. */
export function tx<T>(db: Db, fn: () => T): T {
  if (inTransaction.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTransaction.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback failures; the original error is what matters
    }
    throw err;
  } finally {
    inTransaction.delete(db);
  }
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    key,
    value,
  );
}
