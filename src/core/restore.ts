import { copyFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { invalid, notFound } from './errors.ts';

export interface BackupInfo {
  file: string;
  bytes: number;
  integrity: string;
  schema_version: number;
  projects: number;
  items: number;
  ok: boolean;
}

/** Opens a backup read-only and reports what is inside it. */
export function inspectBackup(file: string): BackupInfo {
  const path = resolve(file);
  if (!existsSync(path)) throw notFound(`backup file not found: ${path}`);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    throw invalid(`${path} is not a readable SQLite database: ${(err as Error).message}`);
  }
  try {
    const integrityRow = db.prepare(`PRAGMA integrity_check`).get() as Record<string, string> | undefined;
    const integrity = integrityRow ? (Object.values(integrityRow)[0] ?? 'unknown') : 'unknown';

    let schemaVersion = 0;
    try {
      const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
      if (row) schemaVersion = Number.parseInt(row.value, 10) || 0;
    } catch {
      schemaVersion = 0;
    }

    const count = (table: string): number => {
      try {
        return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      } catch {
        return 0;
      }
    };

    return {
      file: path,
      bytes: statSync(path).size,
      integrity,
      schema_version: schemaVersion,
      projects: count('projects'),
      items: count('items'),
      ok: integrity === 'ok',
    };
  } catch (err) {
    throw invalid(`${path} is not a readable SQLite database: ${(err as Error).message}`);
  } finally {
    db.close();
  }
}

export interface RestoreResult {
  target: string;
  previous: string | null;
  info: BackupInfo;
}

/**
 * Replaces the live database with a backup. The caller must have stopped the
 * service first (the CLI does); the old file is kept next to the new one.
 */
export function restoreDatabase(
  backupFile: string,
  dbPath: string,
  opts: { currentSchema?: number } = {},
): RestoreResult {
  const info = inspectBackup(backupFile);
  if (resolve(info.file) === resolve(dbPath)) {
    throw invalid('that file is the live database, not a backup');
  }
  if (!info.ok) throw invalid(`backup failed integrity_check (${info.integrity})`);
  if (opts.currentSchema !== undefined && info.schema_version > opts.currentSchema) {
    throw invalid(
      `backup schema v${info.schema_version} is newer than this program (v${opts.currentSchema}); update qpool first`,
    );
  }

  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  let previous: string | null = null;
  if (existsSync(dbPath)) {
    previous = `${dbPath}.pre-restore-${stamp}`;
    renameSync(dbPath, previous);
  }
  for (const suffix of ['-wal', '-shm']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  copyFileSync(info.file, dbPath);

  return { target: dbPath, previous, info };
}
