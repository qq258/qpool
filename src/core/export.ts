import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { getProjectByCode } from './projects.ts';
import type { ProjectView } from './projects.ts';
import { allItems, itemLabels } from './items.ts';
import { evaluateGate } from './gate.ts';
import { gateSummary } from './brief.ts';
import { ageLabel, nowIso } from './util.ts';
import type { ItemRow } from './types.ts';

export const SNAPSHOT_DIR = '.qpool';
export const SNAPSHOT_JSONL = 'issues.jsonl';
export const SNAPSHOT_MARKDOWN = 'PROBLEMS.md';

const STATUS_MARK: Record<string, string> = {
  open: 'o',
  triaged: '~',
  in_progress: '>',
  blocked: '!',
  waiting_review: '?',
  closed: 'x',
};

export interface ExportResult {
  project: string;
  dir: string;
  jsonl: string;
  markdown: string;
  items: number;
  at: string;
  gate: string;
}

export function exportProject(db: Db, project: ProjectView): ExportResult {
  const items = allItems(db, project.id);
  const gate = evaluateGate(db, project);
  const at = nowIso();
  const dir = join(project.root_path, SNAPSHOT_DIR);

  const codes = new Map(items.map((item) => [item.id, item.code]));
  const evidenceByItem = new Map<number, Array<{ kind: string; ref: string; note: string; added_at: string }>>();
  const records = items.map((item) => {
    const evidence = db
      .prepare(`SELECT kind, ref, note, added_at FROM evidence WHERE item_id = ? ORDER BY id`)
      .all(item.id) as Array<{ kind: string; ref: string; note: string; added_at: string }>;
    evidenceByItem.set(item.id, evidence);
    const links = db
      .prepare(
        `SELECT l.type, i.code AS target FROM links l JOIN items i ON i.id = l.to_item
         WHERE l.from_item = ? ORDER BY l.type, i.code`,
      )
      .all(item.id);
    return {
      code: item.code,
      project: project.code,
      kind: item.kind,
      severity: item.severity,
      title: item.title,
      body: item.body,
      status: item.status,
      parent: item.parent_id ? (codes.get(item.parent_id) ?? null) : null,
      labels: itemLabels(item),
      created_at: item.created_at,
      updated_at: item.updated_at,
      closed:
        item.status === 'closed'
          ? {
              at: item.closed_at,
              by: item.closed_by,
              by_type: item.closed_by_type,
              kind: item.close_kind,
              reason: item.close_reason,
              signoff: item.signoff_quote,
            }
          : null,
      evidence,
      links,
    };
  });

  const jsonlPath = join(dir, SNAPSHOT_JSONL);
  const markdownPath = join(dir, SNAPSHOT_MARKDOWN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(jsonlPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  writeFileSync(
    markdownPath,
    renderMarkdown(project, items, codes, gate, at, evidenceByItem),
    'utf8',
  );

  return {
    project: project.code,
    dir,
    jsonl: jsonlPath,
    markdown: markdownPath,
    items: items.length,
    at,
    gate: gateSummary(gate),
  };
}

function renderMarkdown(
  project: ProjectView,
  items: ItemRow[],
  codes: Map<number, string>,
  gate: ReturnType<typeof evaluateGate>,
  at: string,
  evidenceByItem: Map<number, Array<{ kind: string; ref: string; note: string; added_at: string }>>,
): string {
  const open = items.filter((item) => item.status !== 'closed');
  const closed = items.filter((item) => item.status === 'closed');
  const lines: string[] = [];

  lines.push(`# ${project.name} (${project.code}) — problems`);
  lines.push('');
  lines.push(`> generated ${at} · ${gate.pass ? 'GATE: PASS' : 'GATE: FAIL'} · ${items.length} items / ${open.length} open`);
  lines.push(`> root: ${project.root_path}`);
  lines.push('');

  lines.push('## Open');
  lines.push('');
  if (open.length === 0) {
    lines.push('_none_');
    lines.push('');
  } else {
    for (const item of open) {
      const mark = STATUS_MARK[item.status] ?? '?';
      const parent = item.parent_id ? codes.get(item.parent_id) : null;
      lines.push(`### [${mark}] ${item.code} — ${item.title}`);
      lines.push('');
      lines.push(`- ${item.kind} / ${item.severity} / ${item.status}${parent ? ` / child of ${parent}` : ''} · age ${ageLabel(item.created_at)}`);
      if (item.block_reason) lines.push(`- blocked: ${item.block_reason}`);
      if (item.body) {
        lines.push('');
        for (const bodyLine of item.body.split(/\r?\n/).slice(0, 12)) lines.push(`  ${bodyLine}`);
      }
      const evidence = evidenceByItem.get(item.id) ?? [];
      if (evidence.length) {
        lines.push('');
        for (const entry of evidence) {
          lines.push(`- evidence [${entry.kind}] ${entry.ref}${entry.note ? ` — ${trimQuote(entry.note)}` : ''}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('## Tree');
  lines.push('');
  for (const line of treeLines(items, codes)) lines.push(line);
  lines.push('');

  lines.push('## Closed');
  lines.push('');
  if (closed.length === 0) {
    lines.push('_none_');
    lines.push('');
  } else {
    for (const item of closed) {
      const signoff = item.signoff_quote ? ` · signed: "${trimQuote(item.signoff_quote)}"` : '';
      lines.push(
        `- **${item.code}** ${item.title} — ${item.close_kind ?? 'closed'}${signoff} — ${trimQuote(item.close_reason ?? '')}`,
      );
    }
    lines.push('');
  }

  if (gate.reasons.length) {
    lines.push('## Gate blockers');
    lines.push('');
    for (const reason of gate.reasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function trimQuote(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 160 ? `${single.slice(0, 160)}…` : single;
}

function treeLines(items: ItemRow[], codes: Map<number, string>): string[] {
  const children = new Map<number | null, ItemRow[]>();
  for (const item of items) {
    const key = item.parent_id ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(item);
  }
  const lines: string[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const item of children.get(parent) ?? []) {
      const mark = STATUS_MARK[item.status] ?? '?';
      lines.push(`${'  '.repeat(depth)}- [${mark}] ${item.code} ${item.title}${item.severity === 'blocker' ? ' (blocker)' : ''}`);
      walk(item.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

/* ------------------------------------------------------------------ */
/* debounced snapshots                                                 */
/* ------------------------------------------------------------------ */

const timers = new Map<string, NodeJS.Timeout>();

/** Called after every mutation; coalesces bursts into one snapshot per project. */
export function scheduleExport(db: Db, project: ProjectView, delayMs = 1500): void {  const existing = timers.get(project.code);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(project.code);
    if (!db.isOpen) return;
    try {
      const fresh = getProjectByCode(db, project.code);
      if (!fresh) return;
      exportProject(db, fresh);
    } catch (err) {
      process.stderr.write(`[qpool] snapshot export failed for ${project.code}: ${(err as Error).message}\n`);
    }
  }, delayMs);
  timer.unref();
  timers.set(project.code, timer);
}

/** Flush every debounced snapshot right now (used on shutdown so nothing is lost). */
export function flushPendingExports(db: Db): number {
  let flushed = 0;
  for (const [code, timer] of [...timers.entries()]) {
    clearTimeout(timer);
    timers.delete(code);
    if (!db.isOpen) continue;
    const project = getProjectByCode(db, code);
    if (!project) continue;
    try {
      exportProject(db, project);
      flushed += 1;
    } catch (err) {
      process.stderr.write(`[qpool] snapshot flush failed for ${code}: ${(err as Error).message}\n`);
    }
  }
  return flushed;
}
