import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { tx } from './db.ts';
import { invalid, invalidState } from './errors.ts';
import { requireItem } from './items.ts';
import { readMarker, requireProject } from './projects.ts';
import type { ProjectView } from './projects.ts';
import { recordEvent } from './events.ts';
import { PACKAGE_ROOT } from './config.ts';
import { nowIso } from './util.ts';

export interface PurgeResult {
  code: string;
  title: string;
  purged: boolean;
}

/**
 * Operator escape hatch for a mistaken or synthetic record: hard-deletes one
 * already-closed item. Not exposed as an MCP tool on purpose — the agent's
 * normal vocabulary stays "close", never "delete". Every purge lands in the
 * project's event log with the reason.
 */
export function purgeClosedItem(db: Db, code: string, reason: string, sessionId?: string): PurgeResult {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 3) throw invalid('a purge reason is required (min 3 chars)');

  return tx(db, () => {
    const item = requireItem(db, code);
    if (item.status !== 'closed') {
      throw invalidState(`${item.code} is ${item.status}; only closed items can be purged (close it first, or fix it)`);
    }
    db.prepare(`DELETE FROM items WHERE id = ?`).run(item.id);
    recordEvent(db, {
      projectId: item.project_id,
      itemId: null,
      sessionId,
      actor: 'human:owner',
      action: 'purge',
      payload: { code: item.code, title: item.title, reason: trimmed, close_kind: item.close_kind },
    });
    return { code: item.code, title: item.title, purged: true };
  });
}

/**
 * Removes a registry entry whose directory no longer exists (e.g. throwaway
 * regression projects). Refuses while anything is still open.
 */
export function forgetProject(db: Db, code: string, reason: string): { code: string; name: string; forgotten: boolean } {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 3) throw invalid('a reason is required (min 3 chars)');

  return tx(db, () => {
    const project: ProjectView = requireProject(db, code);
    const open = (
      db.prepare(`SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND status <> 'closed'`).get(project.id) as {
        n: number;
      }
    ).n;
    if (open > 0) throw invalidState(`project ${project.code} still has ${open} open item(s)`);

    const log = readLog(db);
    log.push({ at: nowIso(), action: 'forget-project', code: project.code, name: project.name, reason: trimmed });
    db.prepare(`INSERT INTO meta (key, value) VALUES ('maintenance_log', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      JSON.stringify(log.slice(-200)),
    );
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(project.id);
    return { code: project.code, name: project.name, forgotten: true };
  });
}

export function readLog(db: Db): Array<Record<string, unknown>> {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'maintenance_log'`).get() as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* backup / doctor                                                    */
/* ------------------------------------------------------------------ */

export const BACKUP_DIR = join(PACKAGE_ROOT, 'data', 'backups');

export interface BackupResult {
  path: string;
  bytes: number;
  removed: string[];
}

/**
 * Consistent point-in-time copy via `VACUUM INTO` (the online backup path for
 * SQLite), then keeps the newest `keep` files.
 */
export function backupDatabase(db: Db, keep = 10, dir = BACKUP_DIR): BackupResult {
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const file = join(dir, `qpool-${stamp}.db`);

  // VACUUM INTO refuses to overwrite; a second backup in the same second gets a suffix.
  let target = file;
  let suffix = 1;
  while (existsSync(target)) {
    target = file.replace(/\.db$/, `-${suffix}.db`);
    suffix += 1;
  }

  db.prepare(`VACUUM INTO ?`).run(target);
  const bytes = statSync(target).size;

  const keepCount = Math.max(1, Math.min(100, Number(keep) || 10));
  const removed: string[] = [];
  const files = readdirSync(dir)
    .filter((name) => /^qpool-.*\.db$/.test(name))
    .sort()
    .reverse();
  for (const name of files.slice(keepCount)) {
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }

  return { path: target, bytes, removed };
}

export interface DoctorProjectReport {  code: string;
  name: string;
  status: string;
  root: string;
  root_exists: boolean;
  marker_code: string | null;
  snapshot_exists: boolean;
  snapshot_age_ms: number | null;
  problems: string[];
}

export interface DoctorReport {
  ok: boolean;
  db: { path: string; integrity: string; size_bytes: number; journal_mode: string };
  counts: { projects: number; items: number; open: number; events: number; evidence: number; backups: number };
  projects: DoctorProjectReport[];
  problems: string[];
}

export function runDoctor(db: Db, dbPath: string, backupDir = BACKUP_DIR): DoctorReport {
  const integrityRow = db.prepare(`PRAGMA integrity_check`).get() as Record<string, string> | undefined;
  const integrity = integrityRow ? Object.values(integrityRow)[0] : 'unknown';
  const journalRow = db.prepare(`PRAGMA journal_mode`).get() as Record<string, string> | undefined;
  const journalMode = journalRow ? Object.values(journalRow)[0] : 'unknown';

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const projects = db
    .prepare(`SELECT p.*, (SELECT COUNT(*) FROM items i WHERE i.project_id = p.id) AS item_count FROM projects p ORDER BY p.code`)
    .all() as Array<ProjectView & { item_count: number }>;

  const problems: string[] = [];
  if (integrity !== 'ok') problems.push(`sqlite integrity_check returned ${integrity}`);

  const projectReports: DoctorProjectReport[] = projects.map((project) => {
    const projectProblems: string[] = [];
    const rootExists = existsSync(project.root_path);
    const marker = rootExists ? readMarker(project.root_path) : null;
    const snapshot = join(project.root_path, '.qpool', 'issues.jsonl');
    const snapshotExists = existsSync(snapshot);
    const snapshotAge = snapshotExists ? Date.now() - statSync(snapshot).mtimeMs : null;

    if (!rootExists) projectProblems.push('root directory is gone (forget-project if it is a throwaway)');
    if (rootExists && !marker) projectProblems.push('missing .qpool/project.json marker');
    if (marker && marker.code !== project.code) {
      projectProblems.push(`marker says ${marker.code} but registry says ${project.code}`);
    }
    if (rootExists && !snapshotExists && project.item_count > 0) {
      projectProblems.push('no snapshot yet (.qpool/issues.jsonl)');
    }

    for (const problem of projectProblems) problems.push(`${project.code}: ${problem}`);
    return {
      code: project.code,
      name: project.name,
      status: project.status,
      root: project.root_path,
      root_exists: rootExists,
      marker_code: marker?.code ?? null,
      snapshot_exists: snapshotExists,
      snapshot_age_ms: snapshotAge,
      problems: projectProblems,
    };
  });

  const backupCount = existsSync(backupDir)
    ? readdirSync(backupDir).filter((name) => name.endsWith('.db')).length
    : 0;

  return {
    ok: problems.length === 0,
    db: {
      path: dbPath,
      integrity,
      size_bytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
      journal_mode: journalMode,
    },
    counts: {
      projects: projects.length,
      items: count(`SELECT COUNT(*) AS n FROM items`),
      open: count(`SELECT COUNT(*) AS n FROM items WHERE status <> 'closed'`),
      events: count(`SELECT COUNT(*) AS n FROM events`),
      evidence: count(`SELECT COUNT(*) AS n FROM evidence`),
      backups: backupCount,
    },
    projects: projectReports,
    problems,
  };
}

/** Age of the newest backup, or null when there is none yet. */
export function latestBackupAgeMs(dir = BACKUP_DIR): number | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => /^qpool-.*\.db$/.test(name));
  if (files.length === 0) return null;
  let newest = 0;
  for (const name of files) {
    const at = statSync(join(dir, name)).mtimeMs;
    if (at > newest) newest = at;
  }
  return Date.now() - newest;
}
