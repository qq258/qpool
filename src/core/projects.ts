import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Db } from './db.ts';
import { tx } from './db.ts';
import { badRequest, conflict, invalid, invalidState, notFound, QpoolError } from './errors.ts';
import { claimCutoff } from './claims.ts';
import { recordEvent } from './events.ts';
import { nowIso, parseJsonArray, randomHex } from './util.ts';

export interface ProjectRow {
  id: number;
  code: string;
  name: string;
  root_path: string;
  root_key: string;
  aliases: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectView extends ProjectRow {
  aliases_list: string[];
  item_count: number;
  open_count: number;
  blocker_open: number;
  waiting_review: number;
  /** Fresh claims (within the TTL) held by any conversation. */
  claimed_total: number;
  /** Fresh claims held by a conversation other than the caller's. */
  claimed_other: number;
  /** Distinct conversations holding those claims. */
  claimed_sessions: number;
  /** Issue codes locked by someone else, capped for display. */
  claimed_other_codes: string[];
}

export const MARKER_DIR = '.qpool';
export const MARKER_FILE = 'project.json';
export const CODE_PATTERN = /^[A-Z][A-Z0-9]{1,11}$/;

export function normalizeRootKey(inputPath: string): string {
  const abs = resolve(inputPath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

export function deriveCode(name: string): string {
  const letters = name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 12);
  if (letters.length >= 2) return letters;
  return `P${randomHex(2).toUpperCase()}`;
}

export function assertCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    throw invalid(`project code must match ${CODE_PATTERN} (2-12 chars, A-Z/0-9, starting with a letter)`, { code });
  }
  return normalized;
}

export function markerPath(rootPath: string): string {
  return join(rootPath, MARKER_DIR, MARKER_FILE);
}

interface MarkerPayload {
  code: string;
  name?: string;
  created_at?: string;
}

export function readMarker(rootPath: string): MarkerPayload | null {
  const file = markerPath(rootPath);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Partial<MarkerPayload>;
    if (!parsed || typeof parsed.code !== 'string' || !CODE_PATTERN.test(parsed.code.toUpperCase())) return null;
    return { code: parsed.code.toUpperCase(), name: parsed.name, created_at: parsed.created_at };
  } catch {
    return null;
  }
}

export function writeMarker(rootPath: string, payload: MarkerPayload): void {
  mkdirSync(join(rootPath, MARKER_DIR), { recursive: true });
  writeFileSync(markerPath(rootPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export interface RegisterProjectInput {
  path?: string;
  root?: string;
  code?: string;
  name?: string;
  aliases?: string[];
}

export function registerProject(db: Db, input: RegisterProjectInput): ProjectView {
  const rawPath = input.path ?? input.root;
  if (!rawPath) throw badRequest('path is required to register a project');
  const rootPath = resolve(rawPath);
  if (!existsSync(rootPath)) throw notFound(`project path does not exist: ${rootPath}`);

  const rootKey = normalizeRootKey(rootPath);
  const existing = db.prepare(`SELECT * FROM projects WHERE root_key = ?`).get(rootKey) as ProjectRow | undefined;
  if (existing) return toView(db, existing);

  const marker = readMarker(rootPath);
  const code = assertCode(input.code ?? marker?.code ?? deriveCode(input.name ?? basename(rootPath)));
  const name = (input.name ?? marker?.name ?? basename(rootPath)).trim() || basename(rootPath);

  const codeTaken = db.prepare(`SELECT * FROM projects WHERE code = ?`).get(code) as ProjectRow | undefined;
  if (codeTaken) {
    throw conflict(`project code ${code} already belongs to ${codeTaken.root_path}`, { code, root_path: codeTaken.root_path });
  }

  const at = nowIso();
  const aliases = JSON.stringify((input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean));

  const row = tx(db, () => {
    db.prepare(
      `INSERT INTO projects (code, name, root_path, root_key, aliases, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(code, name, rootPath, rootKey, aliases, at, at);
    const created = db.prepare(`SELECT * FROM projects WHERE root_key = ?`).get(rootKey) as ProjectRow;
    return created;
  });

  if (!marker || marker.code !== code) {
    writeMarker(rootPath, { code, name, created_at: row.created_at });
  }

  return toView(db, row);
}

/** Adopt a project whose marker exists but has no registry row (e.g. DB restored from scratch). */
function adoptFromMarker(db: Db, rootPath: string, marker: MarkerPayload): ProjectRow {
  const rootKey = normalizeRootKey(rootPath);
  const at = nowIso();
  const name = (marker.name ?? basename(rootPath)).trim() || basename(rootPath);
  db.prepare(
    `INSERT INTO projects (code, name, root_path, root_key, aliases, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', 'active', ?, ?)`,
  ).run(marker.code, name, rootPath, rootKey, at, at);
  return db.prepare(`SELECT * FROM projects WHERE root_key = ?`).get(rootKey) as ProjectRow;
}

export function listProjects(db: Db, opts: ViewOptions = {}): ProjectView[] {
  // Active projects first (that is what "what am I working on" means), frozen last.
  const rows = db.prepare(`SELECT * FROM projects ORDER BY (status = 'archived'), code`).all() as ProjectRow[];
  return rows.map((row) => toView(db, row, opts));
}

export interface ViewOptions {
  /** Caller's conversation; claims by anyone else count as "other". */
  sessionId?: string;
  ttlMs?: number;
}

export function toView(db: Db, row: ProjectRow, opts: ViewOptions = {}): ProjectView {
  const cutoff = claimCutoff(opts.ttlMs);
  const session = opts.sessionId ?? '';

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM items WHERE project_id = ?) AS item_count,
         (SELECT COUNT(*) FROM items WHERE project_id = ? AND status <> 'closed') AS open_count,
         (SELECT COUNT(*) FROM items WHERE project_id = ? AND severity = 'blocker' AND status <> 'closed') AS blocker_open,
         (SELECT COUNT(*) FROM items WHERE project_id = ? AND status = 'waiting_review') AS waiting_review,
         (SELECT COUNT(*) FROM items WHERE project_id = ? AND claimed_by IS NOT NULL AND claimed_at >= ?) AS claimed_total,
         (SELECT COUNT(*) FROM items WHERE project_id = ? AND claimed_by IS NOT NULL AND claimed_at >= ? AND claimed_by <> ?) AS claimed_other,
         (SELECT COUNT(DISTINCT claimed_by) FROM items WHERE project_id = ? AND claimed_by IS NOT NULL AND claimed_at >= ? AND claimed_by <> ?) AS claimed_sessions`,
    )
    .get(
      row.id,
      row.id,
      row.id,
      row.id,
      row.id,
      cutoff,
      row.id,
      cutoff,
      session,
      row.id,
      cutoff,
      session,
    ) as {
    item_count: number;
    open_count: number;
    blocker_open: number;
    waiting_review: number;
    claimed_total: number;
    claimed_other: number;
    claimed_sessions: number;
  };

  const claimedOtherCodes =
    counts.claimed_other > 0
      ? (db
          .prepare(
            `SELECT code FROM items
             WHERE project_id = ? AND claimed_by IS NOT NULL AND claimed_at >= ? AND claimed_by <> ?
             ORDER BY code LIMIT 5`,
          )
          .all(row.id, cutoff, session) as Array<{ code: string }>).map((entry) => entry.code)
      : [];

  return {
    ...row,
    aliases_list: parseJsonArray(row.aliases),
    item_count: counts.item_count,
    open_count: counts.open_count,
    blocker_open: counts.blocker_open,
    waiting_review: counts.waiting_review,
    claimed_total: counts.claimed_total,
    claimed_other: counts.claimed_other,
    claimed_sessions: counts.claimed_sessions,
    claimed_other_codes: claimedOtherCodes,
  };
}

export function getProjectByCode(db: Db, code: string): ProjectView | null {
  const normalized = code.trim().toUpperCase();
  const row = db.prepare(`SELECT * FROM projects WHERE code = ?`).get(normalized) as ProjectRow | undefined;
  if (row) return toView(db, row);

  const byAlias = db
    .prepare(`SELECT * FROM projects WHERE EXISTS (SELECT 1 FROM json_each(projects.aliases) WHERE upper(value) = ?)`)
    .get(normalized) as ProjectRow | undefined;
  return byAlias ? toView(db, byAlias) : null;
}

export function requireProject(db: Db, code: string): ProjectView {
  const project = getProjectByCode(db, code);
  if (!project) throw notFound(`unknown project: ${code}`, { known: listProjects(db).map((p) => p.code) });
  return project;
}

export function requireProjectById(db: Db, id: number): ProjectView {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
  if (!row) throw notFound(`unknown project id: ${id}`);
  return toView(db, row);
}

/** Walk up from `startPath` looking for a `.qpool/project.json` marker. */
export function findProjectForPath(db: Db, startPath: string): ProjectView | null {
  let current = resolve(startPath);
  for (;;) {
    const marker = readMarker(current);
    if (marker) {
      const row = db.prepare(`SELECT * FROM projects WHERE code = ?`).get(marker.code) as ProjectRow | undefined;
      if (row) return toView(db, row);
      return toView(db, adoptFromMarker(db, current, marker));
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }

  // No marker anywhere up the tree: fall back to the longest registered root that
  // contains this path (covers sessions started in a subdirectory of a project).
  const key = normalizeRootKey(startPath);
  const candidates = listProjects(db)
    .filter((project) => {
      const root = project.root_key;
      return key === root || key.startsWith(`${root}\\`) || key.startsWith(`${root}/`);
    })
    .sort((a, b) => b.root_key.length - a.root_key.length);
  return candidates[0] ?? null;
}

export interface ResolveInput {
  project?: string;
  root?: string;
  cwd?: string;
}

export function isPathLike(value: string): boolean {
  return /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
}

/** Resolve a project from an explicit code, an explicit path, or the session cwd. */
export function resolveProject(db: Db, input: ResolveInput = {}): ProjectView {
  if (input.project) {
    if (isPathLike(input.project)) {
      const found = findProjectForPath(db, input.project);
      if (found) return found;
      throw notFound(`no qpool project registered at or above ${input.project}`, {
        known: listProjects(db).map((p) => p.code),
      });
    }
    return requireProject(db, input.project);
  }

  const start = input.root ?? input.cwd ?? process.cwd();
  const found = findProjectForPath(db, start);
  if (found) return found;

  throw notFound(`no qpool project found from ${start}. Register one with q_projects action=init`, {
    known: listProjects(db).map((p) => p.code),
  });
}

export function touchProject(db: Db, projectId: number): void {
  db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(nowIso(), projectId);
}

/**
 * Guard for every mutation. A project is frozen once archived (i.e. after its
 * gate passed and the owner called it done); reopening takes an explicit act.
 */
export function assertProjectWritable(db: Db, projectId: number): void {
  const row = db.prepare(`SELECT code, status FROM projects WHERE id = ?`).get(projectId) as
    | { code: string; status: string }
    | undefined;
  if (!row) throw notFound(`unknown project id: ${projectId}`);
  if (row.status === 'archived') {
    throw new QpoolError(
      'INVALID_STATE',
      `project ${row.code} is frozen (archived): no more changes. Ask the owner, then call q_projects action=unarchive`,
      { project: row.code, reason: 'project_frozen' },
    );
  }
}

export interface ArchiveResult {
  project: ProjectView;
  frozen: boolean;
}

/** Freeze a finished project: only allowed once every item is closed. */
export function setProjectArchived(db: Db, code: string, archived: boolean, reason?: string): ArchiveResult {
  return tx(db, () => {
    const project = requireProject(db, code);
    if (archived && project.status === 'archived') {
      throw invalidState(`${project.code} is already frozen`);
    }
    if (archived) {
      const open = (
        db.prepare(`SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND status <> 'closed'`).get(project.id) as {
          n: number;
        }
      ).n;
      if (open > 0) {
        throw invalidState(`${project.code} still has ${open} open item(s); a project can only be frozen when everything is closed`, {
          open,
        });
      }
    } else if (project.status !== 'archived') {
      throw invalidState(`${project.code} is not frozen`);
    }

    const next = archived ? 'archived' : 'active';
    const at = nowIso();
    db.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run(next, at, project.id);
    recordEvent(db, {
      projectId: project.id,
      itemId: null,
      actor: 'agent',
      action: archived ? 'project_freeze' : 'project_unfreeze',
      payload: { reason: (reason ?? '').trim() || null },
    });
    return { project: requireProject(db, project.code), frozen: archived };
  });
}
