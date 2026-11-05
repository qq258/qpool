import type { Db } from './db.ts';
import type { EventRow } from './types.ts';
import { nowIso } from './util.ts';

export interface RecordEventInput {
  projectId: number;
  itemId?: number | null;
  sessionId?: string | null;
  actor?: string;
  action: string;
  payload?: unknown;
}

export function recordEvent(db: Db, input: RecordEventInput): void {
  db.prepare(
    `INSERT INTO events (project_id, item_id, session_id, actor, action, payload, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.projectId,
    input.itemId ?? null,
    input.sessionId ?? null,
    input.actor ?? 'agent',
    input.action,
    JSON.stringify(input.payload ?? {}),
    nowIso(),
  );
}

export function listEvents(db: Db, itemId: number, limit = 25): EventRow[] {
  return db
    .prepare(`SELECT * FROM events WHERE item_id = ? ORDER BY id DESC LIMIT ?`)
    .all(itemId, limit) as EventRow[];
}

export function listProjectEvents(db: Db, projectId: number, limit = 10): EventRow[] {
  return db
    .prepare(`SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?`)
    .all(projectId, limit) as EventRow[];
}
