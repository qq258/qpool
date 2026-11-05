import type { Db } from './db.ts';
import type { ProjectView } from './projects.ts';
import { allItems, openChildren } from './items.ts';
import { evaluateGate } from './gate.ts';
import type { GateResult } from './gate.ts';
import { listProjectEvents } from './events.ts';
import { isClaimFresh } from './claims.ts';
import { ageLabel } from './util.ts';
import type { ItemRow } from './types.ts';

export interface BriefItem {
  code: string;
  title: string;
  severity?: string;
  status?: string;
  kind?: string;
  age: string;
  created_at: string;
  note?: string | null;
  holder?: string | null;
}

export interface BriefResult {
  project: { code: string; name: string; root: string; status: string };
  counts: {
    total: number;
    open: number;
    closed: number;
    blocker_open: number;
    waiting_review: number;
    blocked: number;
    close_rate: number;
  };
  /** Things the owner has to sign: the top of the queue. */
  needs_owner: BriefItem[];
  blocker_open: BriefItem[];
  blocked: BriefItem[];
  in_progress: BriefItem[];
  /** Open issues currently claimed by some conversation (within the TTL). */
  claimed: BriefItem[];
  recent: Array<{ at: string; actor: string; action: string; code: string | null; when: string }>;
  gate: { pass: boolean; reasons: string[] };
}

export function buildBrief(db: Db, project: ProjectView): BriefResult {
  const items = allItems(db, project.id);
  const open = items.filter((item) => item.status !== 'closed');

  const waiting = items.filter((item) => item.status === 'waiting_review');
  const blockers = open.filter((item) => item.severity === 'blocker' && item.status !== 'waiting_review');
  const blocked = open.filter((item) => item.status === 'blocked');
  const doing = open.filter((item) => item.status === 'in_progress');

  const codeById = new Map(items.map((item) => [item.id as number, item.code]));
  const recent = listProjectEvents(db, project.id, 8).map((event) => ({
    at: event.at,
    actor: event.actor,
    action: event.action,
    code: event.item_id ? (codeById.get(event.item_id) ?? null) : null,
    when: ageLabel(event.at),
  }));

  const gate = evaluateGate(db, project);

  return {
    project: { code: project.code, name: project.name, root: project.root_path, status: project.status },
    counts: {
      total: items.length,
      open: open.length,
      closed: items.length - open.length,
      blocker_open: open.filter((item) => item.severity === 'blocker').length,
      waiting_review: waiting.length,
      blocked: blocked.length,
      close_rate: items.length === 0 ? 1 : Number(((items.length - open.length) / items.length).toFixed(3)),
    },
    needs_owner: waiting.map(toBriefItem),
    blocker_open: blockers.map(toBriefItem),
    blocked: blocked.map((item) => ({ ...toBriefItem(item), note: item.block_reason })),
    in_progress: doing.map(toBriefItem),
    claimed: open
      .filter((item) => item.claimed_by && isClaimFresh(item.claimed_at))
      .map((item) => ({ ...toBriefItem(item), holder: item.claimed_by })),
    recent,
    gate: { pass: gate.pass, reasons: gate.reasons },
  };
}

export function gateSummary(gate: GateResult): string {
  if (gate.pass) {
    return `PASS (${gate.closed}/${gate.total} closed${gate.accepted_risk.length ? `, ${gate.accepted_risk.length} risk-accepted` : ''})`;
  }
  return `FAIL — ${gate.reasons.join('; ')}`;
}

function toBriefItem(item: ItemRow): BriefItem {
  return {
    code: item.code,
    title: item.title,
    severity: item.severity,
    status: item.status,
    kind: item.kind,
    age: ageLabel(item.created_at),
    created_at: item.created_at,
    note: item.block_reason,
  };
}

export interface ChildProgress {
  open_children: number;
  closed_children: number;
}

export function childProgress(db: Db, item: ItemRow): ChildProgress {
  const open = openChildren(db, item.id).length;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM items WHERE parent_id = ?`).get(item.id) as { n: number }
  ).n;
  return { open_children: open, closed_children: total - open };
}
