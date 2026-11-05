import { ageLabel } from '../core/util.ts';

export { displayWidth, padCell } from '../core/util.ts';

export interface ItemLike {
  code: string;
  title: string;
  status: string;
  severity: string;
  kind: string;
  created_at: string;
  updated_at?: string;
  block_reason?: string | null;
  version?: number;
}

const STATUS_TAG: Record<string, string> = {
  open: 'open',
  triaged: 'triaged',
  in_progress: 'doing',
  blocked: 'blocked',
  waiting_review: 'REVIEW',
  closed: 'closed',
};

const SEV_TAG: Record<string, string> = {
  blocker: 'BLOCKER',
  major: 'major',
  minor: 'minor',
};

export function statusTag(status: string): string {
  return STATUS_TAG[status] ?? status;
}

export function sevTag(severity: string): string {
  return SEV_TAG[severity] ?? severity;
}

export function itemLine(item: ItemLike, extra?: string): string {
  const note = extra ?? (item.block_reason ? ` | ${item.block_reason}` : '');
  return `  ${item.code} [${statusTag(item.status)}/${sevTag(item.severity)}/${item.kind}] ${trim(item.title, 110)} · ${ageLabel(item.created_at)}${note}`;
}

export function header(title: string): string {
  return `${title}\n${'-'.repeat(Math.min(60, Math.max(8, title.length)))}`;
}

export function section(title: string, lines: string[]): string {
  if (lines.length === 0) return '';
  return `${title}\n${lines.join('\n')}`;
}

export function trim(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

export function bullets(lines: string[]): string[] {
  return lines.filter(Boolean);
}
