import type { Db } from './db.ts';
import { tx } from './db.ts';
import { conflict, invalid, invalidState, notFound } from './errors.ts';
import type { ProjectView } from './projects.ts';
import { assertProjectWritable, touchProject } from './projects.ts';
import {
  CLOSE_KINDS,
  EVIDENCE_KINDS,
  KINDS,
  LINK_TYPES,
  SEVERITIES,
  STATUSES,
} from './types.ts';
import type {
  CloseKind,
  EvidenceKind,
  ItemLinkRow,
  ItemRow,
  Kind,
  LinkType,
  Severity,
  Status,
} from './types.ts';
import { nowIso, parseJsonArray, oneOf, truncate } from './util.ts';
import { claimCutoff, isClaimFresh, CLAIM_TTL_MS } from './claims.ts';
import { listEvents, recordEvent } from './events.ts';
import type { EventRow } from './types.ts';

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;

/* ------------------------------------------------------------------ */
/* validation helpers                                                  */
/* ------------------------------------------------------------------ */

function enumValue<T extends string>(value: unknown, allowed: readonly T[], name: string, fallback?: T): T {
  try {
    return oneOf(value, allowed, name, fallback);
  } catch (err) {
    throw invalid((err as Error).message, { field: name, allowed });
  }
}

function requireText(value: unknown, name: string, min = 1, max = 20_000): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw invalid(`${name} is required (min ${min} chars)`);
  if (text.length > max) throw invalid(`${name} is too long (max ${max} chars)`);
  return text;
}

/* ------------------------------------------------------------------ */
/* lookups                                                             */
/* ------------------------------------------------------------------ */

export function findItem(db: Db, code: string): ItemRow | null {
  const row = db.prepare(`SELECT * FROM items WHERE code = ?`).get(code.trim().toUpperCase()) as ItemRow | undefined;
  return row ?? null;
}

export function requireItem(db: Db, code: string): ItemRow {
  const item = findItem(db, code);
  if (!item) throw notFound(`unknown item: ${code}`);
  return item;
}

export function countEvidence(db: Db, itemId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM evidence WHERE item_id = ?`).get(itemId) as { n: number }).n;
}

export function openChildren(db: Db, itemId: number): ItemRow[] {
  return db
    .prepare(`SELECT * FROM items WHERE parent_id = ? AND status <> 'closed' ORDER BY code`)
    .all(itemId) as ItemRow[];
}

function nextSeq(db: Db, projectId: number): number {
  const row = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM items WHERE project_id = ?`).get(projectId) as {
    seq: number;
  };
  return row.seq + 1;
}

/* ------------------------------------------------------------------ */
/* create                                                              */
/* ------------------------------------------------------------------ */

export interface EvidenceInput {
  kind?: EvidenceKind | string;
  ref?: string;
  note?: string;
}

export interface CreateItemInput {
  kind?: Kind | string;
  severity?: Severity | string;
  title: string;
  body?: string;
  parent?: string | null;
  labels?: string[];
  links?: Array<{ type: LinkType | string; to: string }>;
  sessionId?: string;
  actor?: string;
  clientOpId?: string;
}

export function createItem(db: Db, project: ProjectView, input: CreateItemInput): ItemRow {
  const idempotent = lookupOp(db, project, input.clientOpId);
  if (idempotent) return idempotent;

  const title = requireText(input.title, 'title', 3, 300);
  const kind = enumValue(input.kind, KINDS, 'kind', 'defect');
  const severity = enumValue(input.severity, SEVERITIES, 'severity', 'major');
  const body = typeof input.body === 'string' ? input.body.trim().slice(0, 20_000) : '';
  const labels = JSON.stringify(sanitizeLabels(input.labels));

  return tx(db, () => {
    assertProjectWritable(db, project.id);
    const parent = input.parent ? requireItem(db, input.parent) : null;
    if (parent) {
      if (parent.project_id !== project.id) throw invalid(`parent ${parent.code} belongs to another project`);
      if (parent.status === 'closed') {
        throw invalidState(`cannot add a child to closed item ${parent.code}; reopen it first`);
      }
    }

    const seq = nextSeq(db, project.id);
    const code = `${project.code}-${seq}`;
    const at = nowIso();

    const result = db
      .prepare(
        `INSERT INTO items (project_id, seq, code, kind, severity, title, body, status, parent_id, depth, path, labels, version, created_at, updated_at, created_by, created_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, '', ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        seq,
        code,
        kind,
        severity,
        title,
        body,
        parent?.id ?? null,
        parent ? parent.depth + 1 : 0,
        labels,
        at,
        at,
        input.actor ?? 'agent',
        input.sessionId ?? null,
      );

    const id = Number(result.lastInsertRowid);
    const path = parent ? `${parent.path}${id}/` : `/${id}/`;
    db.prepare(`UPDATE items SET path = ? WHERE id = ?`).run(path, id);

    if (input.links?.length) {
      for (const link of input.links) {
        insertLink(db, project, { fromItem: id, type: link.type, to: link.to });
      }
    }

    recordEvent(db, {
      projectId: project.id,
      itemId: id,
      sessionId: input.sessionId,
      actor: input.actor ?? 'agent',
      action: 'create',
      payload: { code, kind, severity, parent: parent?.code ?? null },
    });
    touchProject(db, project.id);
    rememberOp(db, project, input.clientOpId, code);
    return requireItem(db, code);
  });
}

export interface BatchCreateResult {
  parent: ItemRow;
  created: ItemRow[];
}

export function createChildBatch(
  db: Db,
  project: ProjectView,
  parentCode: string,
  children: CreateItemInput[],
  opts: { sessionId?: string; actor?: string } = {},
): BatchCreateResult {
  if (!Array.isArray(children) || children.length === 0) throw invalid('items[] must contain at least one child');
  if (children.length > 30) throw invalid('at most 30 children per batch');
  const parent = requireItem(db, parentCode);
  if (parent.project_id !== project.id) throw notFound(`${parentCode} does not belong to ${project.code}`);
  assertProjectWritable(db, project.id);

  const created = tx(db, () =>
    children.map((child) =>
      createItem(db, project, {
        ...child,
        parent: parent.code,
        sessionId: opts.sessionId,
        actor: opts.actor,
      }),
    ),
  );

  recordEvent(db, {
    projectId: project.id,
    itemId: parent.id,
    sessionId: opts.sessionId,
    actor: opts.actor ?? 'agent',
    action: 'decompose',
    payload: { parent: parent.code, children: created.map((item) => item.code) },
  });

  return { parent: requireItem(db, parentCode), created };
}

/* ------------------------------------------------------------------ */
/* idempotency                                                        */
/* ------------------------------------------------------------------ */

function opKey(project: ProjectView, clientOpId: string): string {
  return `${project.code}:${clientOpId}`;
}

function lookupOp(db: Db, project: ProjectView, clientOpId?: string): ItemRow | null {
  if (!clientOpId) return null;
  const row = db.prepare(`SELECT result FROM ops WHERE key = ?`).get(opKey(project, clientOpId)) as
    | { result: string }
    | undefined;
  if (!row) return null;
  const code = (JSON.parse(row.result) as { code: string }).code;
  return findItem(db, code);
}

function rememberOp(db: Db, project: ProjectView, clientOpId: string | undefined, code: string): void {
  if (!clientOpId) return;
  db.prepare(`INSERT OR REPLACE INTO ops (key, result, at) VALUES (?, ?, ?)`).run(
    opKey(project, clientOpId),
    JSON.stringify({ code }),
    nowIso(),
  );
}

/* ------------------------------------------------------------------ */
/* list / search                                                       */
/* ------------------------------------------------------------------ */

export interface ListFilters {
  status?: string[];
  kind?: string[];
  severity?: string[];
  parent?: string;
  labels?: string[];
  q?: string;
  limit?: number;
  cursor?: string;
  includeClosed?: boolean;
}

export interface ListResult {
  items: ItemRow[];
  nextCursor: string | null;
  total: number;
}

export function listItems(db: Db, project: ProjectView, filters: ListFilters = {}): ListResult {
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(filters.limit) || DEFAULT_LIST_LIMIT));
  const where: string[] = ['items.project_id = ?'];
  const params: unknown[] = [project.id];

  const statuses = normalizeList(filters.status);
  if (statuses.length) {
    where.push(`items.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses.map((value) => enumValue(value, STATUSES, 'status')));
  } else if (!filters.includeClosed) {
    where.push(`items.status <> 'closed'`);
  }

  const kinds = normalizeList(filters.kind);
  if (kinds.length) {
    where.push(`items.kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds.map((value) => enumValue(value, KINDS, 'kind')));
  }

  const severities = normalizeList(filters.severity);
  if (severities.length) {
    where.push(`items.severity IN (${severities.map(() => '?').join(',')})`);
    params.push(...severities.map((value) => enumValue(value, SEVERITIES, 'severity')));
  }

  if (filters.parent) {
    const parent = requireItem(db, filters.parent);
    where.push('items.parent_id = ?');
    params.push(parent.id);
  }

  const labels = normalizeList(filters.labels);
  for (const label of labels) {
    where.push(`EXISTS (SELECT 1 FROM json_each(items.labels) WHERE lower(value) = ?)`);
    params.push(label.toLowerCase());
  }

  const q = (filters.q ?? '').trim();
  if (q.length >= 3) {
    where.push(`items.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)`);
    params.push(`"${q.replace(/"/g, '""')}"`);
  } else if (q.length > 0) {
    where.push(`(items.title LIKE ? OR items.body LIKE ? OR items.code LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const cursor = decodeCursor(filters.cursor);
  if (cursor) {
    where.push(`(items.updated_at < ? OR (items.updated_at = ? AND items.id < ?))`);
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }

  const rows = db
    .prepare(
      `SELECT items.* FROM items
       WHERE ${where.join(' AND ')}
       ORDER BY items.updated_at DESC, items.id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as ItemRow[];

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND status <> 'closed'`).get(project.id) as {
      n: number;
    }
  ).n;

  return { items: page, nextCursor, total };
}

function normalizeList(input: string[] | string | undefined): string[] {
  if (!input) return [];
  const values = Array.isArray(input) ? input : String(input).split(',');
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function encodeCursor(item: ItemRow | undefined): string | null {
  if (!item) return null;
  return Buffer.from(`${item.updated_at}|${item.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; id: number } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const index = raw.lastIndexOf('|');
    const updatedAt = raw.slice(0, index);
    const id = Number.parseInt(raw.slice(index + 1), 10);
    if (!updatedAt || !Number.isFinite(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* detail / tree                                                       */
/* ------------------------------------------------------------------ */

export interface ItemDetail {
  item: ItemRow;
  project: { code: string; name: string };
  ancestors: Array<{ code: string; title: string }>;
  children: ItemRow[];
  childProgress: { closed: number; total: number };
  links: { outgoing: Array<ItemLinkRow & { to_code: string; to_title: string }>; incoming: Array<ItemLinkRow & { from_code: string; from_title: string }> };
  evidence: Array<{ id: number; kind: string; ref: string; note: string; added_by: string; added_at: string }>;
  events: EventRow[];
  blockers: ItemRow[];
}

export function showItem(db: Db, code: string): ItemDetail {
  const item = requireItem(db, code);
  const project = db.prepare(`SELECT code, name FROM projects WHERE id = ?`).get(item.project_id) as {
    code: string;
    name: string;
  };

  const ancestors = db
    .prepare(`SELECT code, title FROM items WHERE project_id = ? AND ? LIKE path || '%' AND id <> ? ORDER BY depth`)
    .all(item.project_id, item.path, item.id) as Array<{ code: string; title: string }>;

  const children = db.prepare(`SELECT * FROM items WHERE parent_id = ? ORDER BY code`).all(item.id) as ItemRow[];
  const childProgress = {
    closed: children.filter((child) => child.status === 'closed').length,
    total: children.length,
  };

  const outgoing = db
    .prepare(
      `SELECT l.*, i.code AS to_code, i.title AS to_title
       FROM links l JOIN items i ON i.id = l.to_item
       WHERE l.from_item = ? ORDER BY l.type, i.code`,
    )
    .all(item.id) as Array<ItemLinkRow & { to_code: string; to_title: string }>;

  const incoming = db
    .prepare(
      `SELECT l.*, i.code AS from_code, i.title AS from_title
       FROM links l JOIN items i ON i.id = l.from_item
       WHERE l.to_item = ? ORDER BY l.type, i.code`,
    )
    .all(item.id) as Array<ItemLinkRow & { from_code: string; from_title: string }>;

  const evidence = db
    .prepare(`SELECT id, kind, ref, note, added_by, added_at FROM evidence WHERE item_id = ? ORDER BY id`)
    .all(item.id) as ItemDetail['evidence'];

  const blockers = db
    .prepare(
      `SELECT i.* FROM links l JOIN items i ON i.id = l.from_item
       WHERE l.to_item = ? AND l.type = 'blocks' AND i.status <> 'closed' ORDER BY i.code`,
    )
    .all(item.id) as ItemRow[];

  return {
    item,
    project,
    ancestors,
    children,
    childProgress,
    links: { outgoing, incoming },
    evidence,
    events: listEvents(db, item.id, 25),
    blockers,
  };
}

export interface TreeNode extends ItemRow {
  children: TreeNode[];
  childProgress: { closed: number; total: number };
}

export function projectTree(db: Db, project: ProjectView): { roots: TreeNode[]; total: number } {
  const rows = db.prepare(`SELECT * FROM items WHERE project_id = ? ORDER BY code`).all(project.id) as ItemRow[];
  const nodes = new Map<number, TreeNode>();
  for (const row of rows) nodes.set(row.id, { ...row, children: [], childProgress: { closed: 0, total: 0 } });

  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    if (node.parent_id && nodes.has(node.parent_id)) nodes.get(node.parent_id)!.children.push(node);
    else roots.push(node);
  }

  const fill = (node: TreeNode): { closed: number; total: number } => {
    let closed = 0;
    let total = 0;
    for (const child of node.children) {
      const stats = fill(child);
      closed += stats.closed;
      total += stats.total;
    }
    node.childProgress = { closed, total };
    const own = node.status === 'closed' ? 1 : 0;
    return { closed: closed + own, total: total + 1 };
  };
  for (const root of roots) fill(root);

  return { roots, total: rows.length };
}

/* ------------------------------------------------------------------ */
/* update                                                              */
/* ------------------------------------------------------------------ */

const TRANSITIONS: Record<Status, Status[]> = {
  open: ['triaged', 'in_progress', 'blocked'],
  triaged: ['open', 'in_progress', 'blocked'],
  in_progress: ['triaged', 'blocked'],
  blocked: ['triaged', 'in_progress'],
  waiting_review: ['in_progress', 'blocked'],
  closed: ['open'],
};

export function allowedTransitions(status: Status): Status[] {
  return TRANSITIONS[status] ?? [];
}

export interface UpdateInput {
  version?: number;
  title?: string;
  body?: string;
  kind?: Kind | string;
  severity?: Severity | string;
  labels?: string[];
  status?: Status | string;
  parent?: string | null;
  blockReason?: string;
  sessionId?: string;
  actor?: string;
}

export function updateItem(db: Db, code: string, patch: UpdateInput): ItemRow {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    if (patch.version !== undefined && Number(patch.version) !== item.version) {
      throw conflict(`${item.code} changed since you read it (v${item.version} -> expected v${patch.version})`, {
        current: item,
      });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: Record<string, unknown> = {};

    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(requireText(patch.title, 'title', 3, 300));
      changed.title = patch.title;
    }
    if (patch.body !== undefined) {
      const body = String(patch.body).slice(0, 20_000);
      sets.push('body = ?');
      params.push(body);
      changed.body = true;
    }
    if (patch.kind !== undefined) {
      const kind = enumValue(patch.kind, KINDS, 'kind');
      sets.push('kind = ?');
      params.push(kind);
      changed.kind = kind;
    }
    if (patch.severity !== undefined) {
      const severity = enumValue(patch.severity, SEVERITIES, 'severity');
      sets.push('severity = ?');
      params.push(severity);
      changed.severity = severity;
    }
    if (patch.labels !== undefined) {
      const labels = JSON.stringify(sanitizeLabels(patch.labels));
      sets.push('labels = ?');
      params.push(labels);
      changed.labels = labels;
    }

    if (patch.status !== undefined) {
      const next = enumValue(patch.status, STATUSES, 'status');
      if (next === 'closed') throw invalidState('use the close operation to close an item');
      if (next === 'waiting_review') throw invalidState('use the submit operation to request review');
      if (!TRANSITIONS[item.status].includes(next)) {
        throw invalidState(`illegal transition ${item.status} -> ${next}`, {
          item: item.code,
          allowed: TRANSITIONS[item.status],
        });
      }
      sets.push('status = ?');
      params.push(next);
      changed.status = next;
      sets.push('block_reason = ?');
      params.push(next === 'blocked' ? (patch.blockReason ?? '').trim() || null : null);
    }

    if (patch.parent !== undefined) {
      const parent = patch.parent ? requireItem(db, patch.parent) : null;
      if (parent) {
        if (parent.project_id !== item.project_id) throw invalid('parent belongs to another project');
        if (parent.id === item.id) throw invalid('an item cannot be its own parent');
        if (parent.path.startsWith(item.path)) throw invalid('an item cannot be moved under its own descendant');
        if (parent.status === 'closed') throw invalidState('cannot move an item under a closed parent');
      }
      reparent(db, item, parent);
      changed.parent = parent?.code ?? null;
    }

    if (sets.length === 0) return item;

    sets.push('version = version + 1', 'updated_at = ?');
    params.push(nowIso());

    const result = db
      .prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
      .run(...params, item.id, item.version);
    if (result.changes === 0) throw conflict(`${item.code} was modified concurrently; re-read it`);

    recordEvent(db, {
      projectId: item.project_id,
      itemId: item.id,
      sessionId: patch.sessionId,
      actor: patch.actor ?? 'agent',
      action: 'update',
      payload: changed,
    });
    touchProject(db, item.project_id);
    return requireItem(db, code);
  });
}

function reparent(db: Db, item: ItemRow, parent: ItemRow | null): void {
  const oldPath = item.path;
  const newPath = parent ? `${parent.path}${item.id}/` : `/${item.id}/`;
  const newDepth = parent ? parent.depth + 1 : 0;
  const delta = newDepth - item.depth;

  db.prepare(`UPDATE items SET path = replace(path, ?, ?) WHERE id = ? OR path LIKE ?`).run(
    oldPath,
    newPath,
    item.id,
    `${oldPath}%`,
  );
  if (delta !== 0) {
    db.prepare(`UPDATE items SET depth = depth + ? WHERE id <> ? AND path LIKE ?`).run(delta, item.id, `${newPath}%`);
  }
  db.prepare(`UPDATE items SET parent_id = ?, depth = ? WHERE id = ?`).run(parent?.id ?? null, newDepth, item.id);
}

/* ------------------------------------------------------------------ */
/* close / submit / signoff / reopen                                   */
/* ------------------------------------------------------------------ */

export interface CloseInput {
  closeKind?: CloseKind | string;
  reason?: string;
  byType?: 'agent' | 'human';
  quote?: string;
  sessionId?: string;
  actor?: string;
  evidence?: EvidenceInput[];
}

export function closeItem(db: Db, code: string, input: CloseInput): ItemRow {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    if (item.status === 'closed') throw invalidState(`${item.code} is already closed`);

    if (input.evidence?.length) {
      for (const entry of input.evidence) addEvidence(db, item, entry, input.sessionId);
    }

    const closeKind = enumValue(input.closeKind, CLOSE_KINDS, 'close_kind', 'fixed');
    const reason = requireText(input.reason, 'reason (conclusion)', 3, 20_000);
    const byType = input.byType === 'human' ? 'human' : 'agent';
    const quote = (input.quote ?? '').trim();

    // Structural rule first: a parent cannot close while children are open.
    const children = openChildren(db, item.id);
    if (children.length) {
      throw invalidState(
        `${item.code} still has ${children.length} open child item(s): ${children.map((child) => child.code).join(', ')}`,
        { item: item.code, open_children: children.map((child) => child.code) },
      );
    }

    if (countEvidence(db, item.id) === 0) {
      throw invalidState(`${item.code} cannot be closed without at least one evidence entry`);
    }
    if (byType === 'agent' && (item.severity === 'blocker' || closeKind === 'accepted_risk')) {
      throw invalidState(
        `${item.code} is a blocker (or is being risk-accepted); it needs human signoff. Ask the owner, then call q_signoff`,
        { item: item.code, reason: 'human_signoff_required' },
      );
    }
    if (closeKind === 'accepted_risk' && quote.length === 0) {
      throw invalidState(`accepting risk on ${item.code} requires the owner's signoff quote`);
    }
    if (closeKind === 'duplicate') {
      const hasTarget = db
        .prepare(`SELECT 1 FROM links WHERE from_item = ? AND type = 'duplicate_of' LIMIT 1`)
        .get(item.id);
      if (!hasTarget) throw invalidState(`${item.code} is marked duplicate but has no duplicate_of link`);
    }

    const at = nowIso();
    db.prepare(
      `UPDATE items
       SET status = 'closed', closed_at = ?, closed_by = ?, closed_by_type = ?, close_kind = ?,
           close_reason = ?, signoff_quote = ?, review_kind = NULL, block_reason = NULL,
           claimed_by = NULL, claimed_at = NULL,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).run(
      at,
      byType === 'human' ? 'human:owner' : (input.actor ?? 'agent'),
      byType,
      closeKind,
      reason,
      quote || null,
      at,
      item.id,
      item.version,
    );

    recordEvent(db, {
      projectId: item.project_id,
      itemId: item.id,
      sessionId: input.sessionId,
      actor: input.actor ?? (byType === 'human' ? 'human:owner' : 'agent'),
      action: 'close',
      payload: { close_kind: closeKind, by: byType, evidence: countEvidence(db, item.id), quote: quote || null },
    });
    touchProject(db, item.project_id);
    return requireItem(db, code);
  });
}

export interface SubmitInput {
  conclusion: string;
  closeKind?: CloseKind | string;
  evidence?: EvidenceInput[];
  sessionId?: string;
  actor?: string;
}

export function submitItem(db: Db, code: string, input: SubmitInput): ItemRow {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    if (item.status === 'closed') throw invalidState(`${item.code} is already closed`);
    if (item.status === 'waiting_review') throw invalidState(`${item.code} is already waiting for review`);

    if (input.evidence?.length) {
      for (const entry of input.evidence) addEvidence(db, item, entry);
    }
    if (countEvidence(db, item.id) === 0) {
      throw invalidState(`${item.code} needs at least one evidence entry before review`);
    }

    const conclusion = requireText(input.conclusion, 'conclusion', 3, 20_000);
    const closeKind = enumValue(input.closeKind, CLOSE_KINDS, 'close_kind', 'fixed');
    const at = nowIso();

    db.prepare(
      `UPDATE items
       SET status = 'waiting_review', close_reason = ?, review_kind = ?, block_reason = NULL,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).run(conclusion, closeKind, at, item.id, item.version);

    recordEvent(db, {
      projectId: item.project_id,
      itemId: item.id,
      sessionId: input.sessionId,
      actor: input.actor ?? 'agent',
      action: 'submit',
      payload: { close_kind: closeKind, evidence: countEvidence(db, item.id) },
    });
    touchProject(db, item.project_id);
    return requireItem(db, code);
  });
}

export interface SignoffInput {
  decision: 'approve' | 'accept_risk' | 'reject';
  quote: string;
  note?: string;
  sessionId?: string;
}

export function signoffItem(db: Db, code: string, input: SignoffInput): ItemRow {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    if (item.status !== 'waiting_review') {
      throw invalidState(`${item.code} is ${item.status}; signoff only applies to items waiting for review`);
    }
    const decision = input.decision;
    if (!['approve', 'accept_risk', 'reject'].includes(decision)) {
      throw invalid(`decision must be approve, accept_risk or reject`);
    }
    const quote = typeof input.quote === 'string' ? input.quote.trim() : '';
    if (quote.length < 4) throw invalid("the owner's signoff quote is required (paste what they actually said)");

    if (decision === 'reject') {
      const at = nowIso();
      db.prepare(
        `UPDATE items SET status = 'in_progress', review_kind = NULL, close_reason = NULL,
           version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
      ).run(at, item.id, item.version);
      recordEvent(db, {
        projectId: item.project_id,
        itemId: item.id,
        sessionId: input.sessionId,
        actor: 'human:owner',
        action: 'signoff_reject',
        payload: { quote, note: input.note ?? null },
      });
      touchProject(db, item.project_id);
      return requireItem(db, code);
    }

    const closeKind: CloseKind = decision === 'accept_risk' ? 'accepted_risk' : (item.review_kind ?? 'fixed');
    return closeItem(db, code, {
      closeKind,
      reason: item.close_reason ?? quote,
      byType: 'human',
      quote,
      sessionId: input.sessionId,
      actor: 'human:owner',
    });
  });
}

export function reopenItem(db: Db, code: string, reason: string, sessionId?: string): ItemRow {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    if (item.status !== 'closed') throw invalidState(`${item.code} is not closed`);
    const text = requireText(reason, 'reason', 3, 2_000);
    const at = nowIso();
    db.prepare(
      `UPDATE items SET status = 'open', closed_at = NULL, closed_by = NULL, closed_by_type = NULL,
         close_kind = NULL, close_reason = NULL, review_kind = NULL, signoff_quote = NULL,
         claimed_by = NULL, claimed_at = NULL,
         version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
    ).run(at, item.id, item.version);
    recordEvent(db, {
      projectId: item.project_id,
      itemId: item.id,
      sessionId,
      actor: 'agent',
      action: 'reopen',
      payload: { reason: text },
    });
    touchProject(db, item.project_id);
    return requireItem(db, code);
  });
}

/* ------------------------------------------------------------------ */
/* cross-session claims                                                */
/* ------------------------------------------------------------------ */

export interface ClaimResult {
  item: ItemRow;
  taken_over_from: string | null;
}

/**
 * Locks an issue to the calling conversation. Another live claim (within the
 * TTL) is refused; an expired one is taken over and recorded.
 */
export function claimItem(
  db: Db,
  code: string,
  sessionId: string,
  opts: { ttlMs?: number; force?: boolean } = {},
): ClaimResult {
  const session = (sessionId ?? '').trim();
  if (!session) throw invalid('claim needs a session id (the MCP process supplies one)');

  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    if (item.status === 'closed') throw invalidState(`${item.code} is closed; nothing to claim`);

    const ttl = opts.ttlMs ?? CLAIM_TTL_MS;
    const heldByOther = Boolean(item.claimed_by) && item.claimed_by !== session && isClaimFresh(item.claimed_at, ttl);
    if (heldByOther && !opts.force) {
      throw invalidState(
        `${item.code} is locked by another conversation (@${item.claimed_by}, since ${item.claimed_at}); ` +
          `wait for a release, or ${Math.round(ttl / 60000)} min for the claim to expire`,
        { item: item.code, holder: item.claimed_by, since: item.claimed_at, reason: 'locked_by_other' },
      );
    }

    const at = nowIso();
    const takenOver = item.claimed_by && item.claimed_by !== session ? item.claimed_by : null;
    db.prepare(
      `UPDATE items SET claimed_by = ?, claimed_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).run(session, at, at, item.id, item.version);

    recordEvent(db, {
      projectId: item.project_id,
      itemId: item.id,
      sessionId: session,
      action: takenOver ? 'claim_takeover' : 'claim',
      payload: { session, previous: takenOver },
    });
    touchProject(db, item.project_id);
    return { item: requireItem(db, code), taken_over_from: takenOver };
  });
}

export function releaseItem(db: Db, code: string, sessionId: string, force = false): ItemRow {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    if (!item.claimed_by) return item;
    if (item.claimed_by !== sessionId && !force) {
      throw invalidState(`${item.code} is locked by @${item.claimed_by}, not by this conversation`, {
        holder: item.claimed_by,
      });
    }

    const at = nowIso();
    db.prepare(
      `UPDATE items SET claimed_by = NULL, claimed_at = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).run(at, item.id, item.version);

    recordEvent(db, {
      projectId: item.project_id,
      itemId: item.id,
      sessionId,
      action: 'release',
      payload: { previous: item.claimed_by, forced: force && item.claimed_by !== sessionId },
    });
    touchProject(db, item.project_id);
    return requireItem(db, code);
  });
}

/* ------------------------------------------------------------------ */
/* evidence / links                                                    */
/* ------------------------------------------------------------------ */

export function addEvidence(
  db: Db,
  item: ItemRow,
  input: EvidenceInput,
  sessionId?: string,
): void {
  const kind = enumValue(input.kind, EVIDENCE_KINDS, 'evidence kind', 'other');
  const ref = (input.ref ?? '').trim().slice(0, 2_000);
  const note = (input.note ?? '').trim().slice(0, 5_000);
  if (!ref && !note) throw invalid('evidence needs a ref or a note');
  db.prepare(`INSERT INTO evidence (item_id, kind, ref, note, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    item.id,
    kind,
    ref,
    note,
    'agent',
    nowIso(),
  );
  recordEvent(db, {
    projectId: item.project_id,
    itemId: item.id,
    sessionId,
    action: 'evidence',
    payload: { kind, ref, note: truncate(note, 120) },
  });
  touchProject(db, item.project_id);
}

export function attachEvidence(db: Db, code: string, input: EvidenceInput, sessionId?: string): ItemRow {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    addEvidence(db, item, input, sessionId);
    db.prepare(`UPDATE items SET version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso(), item.id);
    return requireItem(db, code);
  });
}

function insertLink(
  db: Db,
  project: ProjectView,
  input: { fromItem: number; type: LinkType | string; to: string },
): ItemLinkRow {
  const type = enumValue(input.type, LINK_TYPES, 'link type');
  const target = requireItem(db, input.to);
  if (target.project_id !== project.id) throw invalid(`link target ${target.code} belongs to another project`);
  if (target.id === input.fromItem) throw invalid('cannot link an item to itself');
  if (type === 'blocks') assertNoBlockCycle(db, input.fromItem, target.id, target.code);

  const exists = db
    .prepare(`SELECT * FROM links WHERE from_item = ? AND to_item = ? AND type = ?`)
    .get(input.fromItem, target.id, type) as ItemLinkRow | undefined;
  if (exists) return exists;

  const at = nowIso();
  db.prepare(`INSERT INTO links (project_id, from_item, to_item, type, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    project.id,
    input.fromItem,
    target.id,
    type,
    at,
  );
  return db
    .prepare(`SELECT * FROM links WHERE from_item = ? AND to_item = ? AND type = ?`)
    .get(input.fromItem, target.id, type) as ItemLinkRow;
}

/** A `blocks` edge must stay acyclic: A blocks B and B blocks A would deadlock both. */
function assertNoBlockCycle(db: Db, fromItem: number, toItem: number, toCode: string): void {
  const stack = [toItem];
  const seen = new Set<number>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === fromItem) {
      throw invalid(`this blocks link would create a cycle (${toCode} already blocks this item, directly or transitively)`, {
        reason: 'blocks_cycle',
      });
    }
    if (seen.has(current)) continue;
    seen.add(current);
    const rows = db.prepare(`SELECT to_item FROM links WHERE from_item = ? AND type = 'blocks'`).all(current) as Array<{
      to_item: number;
    }>;
    for (const row of rows) stack.push(row.to_item);
  }
}

export function addLink(
  db: Db,
  project: ProjectView,
  code: string,
  input: { type: LinkType | string; to: string },
  sessionId?: string,
): { link: ItemLinkRow; item: ItemRow } {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    const link = insertLink(db, project, { fromItem: item.id, type: input.type, to: input.to });
    recordEvent(db, {
      projectId: project.id,
      itemId: item.id,
      sessionId,
      action: 'link',
      payload: { type: link.type, to: input.to.toUpperCase() },
    });
    touchProject(db, project.id);
    return { link, item: requireItem(db, code) };
  });
}

export function removeLink(db: Db, code: string, linkId: number): { removed: boolean } {
  return tx(db, () => {
    const item = requireItem(db, code);
    assertProjectWritable(db, item.project_id);
    const result = db.prepare(`DELETE FROM links WHERE id = ? AND from_item = ?`).run(linkId, item.id);
    if (result.changes === 0) throw notFound(`no link ${linkId} on ${item.code}`);
    recordEvent(db, {
      projectId: item.project_id,
      itemId: item.id,
      action: 'unlink',
      payload: { link_id: linkId },
    });
    return { removed: true };
  });
}

/* ------------------------------------------------------------------ */
/* helpers exported for gate/brief/export                              */
/* ------------------------------------------------------------------ */

export function allItems(db: Db, projectId: number): ItemRow[] {
  return db.prepare(`SELECT * FROM items WHERE project_id = ? ORDER BY code`).all(projectId) as ItemRow[];
}

export interface SearchHit extends ItemRow {
  project_code: string;
}

export function searchItems(db: Db, q: string, limit = 20): SearchHit[] {
  const query = (q ?? '').trim();
  const capped = Math.min(MAX_LIST_LIMIT, Math.max(1, limit));
  if (query.length < 2) return [];
  if (query.length >= 3) {
    return db
      .prepare(
        `SELECT items.*, p.code AS project_code FROM items
         JOIN projects p ON p.id = items.project_id
         WHERE items.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)
         ORDER BY items.updated_at DESC LIMIT ?`,
      )
      .all(`"${query.replace(/"/g, '""')}"`, capped) as SearchHit[];
  }
  return db
    .prepare(
      `SELECT items.*, p.code AS project_code FROM items
       JOIN projects p ON p.id = items.project_id
       WHERE items.title LIKE ? OR items.code LIKE ?
       ORDER BY items.updated_at DESC LIMIT ?`,
    )
    .all(`%${query}%`, `%${query}%`, capped) as SearchHit[];
}

export function itemLabels(item: ItemRow): string[] {
  return parseJsonArray(item.labels);
}

export function canCloseNow(db: Db, item: ItemRow): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (item.status === 'closed') reasons.push('already closed');
  if (countEvidence(db, item.id) === 0) reasons.push('no evidence');
  if (openChildren(db, item.id).length > 0) reasons.push('open children');
  if (item.severity === 'blocker' && item.closed_by_type !== 'human') reasons.push('needs human signoff');
  return { ok: reasons.length === 0, reasons };
}

export function evidenceCountFor(db: Db, itemId: number): number {
  return countEvidence(db, itemId);
}

function sanitizeLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  const out: string[] = [];
  for (const label of labels) {
    const text = String(label).trim().toLowerCase().slice(0, 40);
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, 12);
}
