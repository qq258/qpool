export const KINDS = ['defect', 'risk', 'question', 'decision', 'debt', 'requirement'] as const;
export const SEVERITIES = ['blocker', 'major', 'minor'] as const;
export const STATUSES = ['open', 'triaged', 'in_progress', 'blocked', 'waiting_review', 'closed'] as const;
export const CLOSE_KINDS = ['fixed', 'accepted_risk', 'duplicate', 'wontfix', 'not_reproducible'] as const;
export const LINK_TYPES = ['blocks', 'relates', 'duplicate_of', 'split_from', 'discovered_from'] as const;
export const EVIDENCE_KINDS = ['commit', 'test', 'file', 'url', 'repro', 'doc', 'other'] as const;

export type Kind = (typeof KINDS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Status = (typeof STATUSES)[number];
export type CloseKind = (typeof CLOSE_KINDS)[number];
export type LinkType = (typeof LINK_TYPES)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ItemRow {
  id: number;
  project_id: number;
  seq: number;
  code: string;
  kind: Kind;
  severity: Severity;
  title: string;
  body: string;
  status: Status;
  parent_id: number | null;
  depth: number;
  path: string;
  labels: string;
  version: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_type: 'agent' | 'human' | null;
  close_kind: CloseKind | null;
  close_reason: string | null;
  review_kind: CloseKind | null;
  block_reason: string | null;
  signoff_quote: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  created_by: string;
  created_session: string | null;
}

export interface ItemLinkRow {
  id: number;
  project_id: number;
  from_item: number;
  to_item: number;
  type: LinkType;
  created_at: string;
}

export interface EvidenceRow {
  id: number;
  item_id: number;
  kind: EvidenceKind;
  ref: string;
  note: string;
  added_by: string;
  added_at: string;
}

export interface EventRow {
  id: number;
  project_id: number;
  item_id: number | null;
  session_id: string | null;
  actor: string;
  action: string;
  payload: string;
  at: string;
}

export const OPEN_STATUSES: Status[] = ['open', 'triaged', 'in_progress', 'blocked', 'waiting_review'];

export function isOpenStatus(status: Status): boolean {
  return status !== 'closed';
}
