import type { Db } from './db.ts';
import type { ProjectView } from './projects.ts';
import { allItems } from './items.ts';
import type { ItemRow } from './types.ts';

export interface GateIssueRef {
  code: string;
  title: string;
  severity: string;
  status: string;
  age_days?: number;
}

export interface GateResult {
  project: { code: string; name: string };
  pass: boolean;
  total: number;
  closed: number;
  open: number;
  close_rate: number;
  open_blockers: GateIssueRef[];
  unsigned_blockers: GateIssueRef[];
  waiting_review: GateIssueRef[];
  accepted_risk: Array<{ code: string; title: string; quote: string | null }>;
  reasons: string[];
}

/**
 * The project-completion gate. Two rules:
 *   1. every item is closed;
 *   2. every blocker that is closed carries a human signoff.
 */
export function evaluateGate(db: Db, project: ProjectView): GateResult {
  const items = allItems(db, project.id);
  const open = items.filter((item) => item.status !== 'closed');
  const closed = items.filter((item) => item.status === 'closed');

  const openBlockers = open
    .filter((item) => item.severity === 'blocker')
    .map((item) => toRef(item));

  const unsignedBlockers = closed
    .filter((item) => item.severity === 'blocker' && (item.closed_by_type !== 'human' || !item.signoff_quote))
    .map((item) => toRef(item));

  const waiting = items
    .filter((item) => item.status === 'waiting_review')
    .map((item) => toRef(item));

  const acceptedRisk = closed
    .filter((item) => item.close_kind === 'accepted_risk')
    .map((item) => ({ code: item.code, title: item.title, quote: item.signoff_quote }));

  const reasons: string[] = [];
  if (open.length > 0) reasons.push(`${open.length} item(s) not closed`);
  if (openBlockers.length > 0) reasons.push(`${openBlockers.length} blocker(s) still open`);
  if (unsignedBlockers.length > 0) reasons.push(`${unsignedBlockers.length} blocker(s) closed without human signoff`);
  if (waiting.length > 0) reasons.push(`${waiting.length} item(s) waiting for the owner's signoff`);

  const pass = open.length === 0 && unsignedBlockers.length === 0;

  return {
    project: { code: project.code, name: project.name },
    pass,
    total: items.length,
    closed: closed.length,
    open: open.length,
    close_rate: items.length === 0 ? 1 : Number((closed.length / items.length).toFixed(3)),
    open_blockers: openBlockers,
    unsigned_blockers: unsignedBlockers,
    waiting_review: waiting,
    accepted_risk: acceptedRisk,
    reasons,
  };
}

function toRef(item: ItemRow): GateIssueRef {
  const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(item.created_at)) / 86_400_000));
  return { code: item.code, title: item.title, severity: item.severity, status: item.status, age_days: ageDays };
}
