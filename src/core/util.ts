import { randomBytes } from 'node:crypto';

const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Terminal-cell width: CJK and full-width punctuation take two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE.test(char) ? 2 : 1;
  return width;
}

export function padCell(text: string, width: number): string {
  const current = displayWidth(text);
  return current >= width ? text : `${text}${' '.repeat(width - current)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonArray(raw: unknown): string[] {
  const value = parseJson<unknown>(raw, []);
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function asString(value: unknown, name: string, opts: { max?: number; required?: boolean } = {}): string {
  const { max = 10_000, required = false } = opts;
  if (value === null || value === undefined) {
    if (required) throw new Error(`${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new Error(`${name} is required`);
  if (trimmed.length > max) throw new Error(`${name} is too long (max ${max} chars)`);
  return trimmed;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string, fallback?: T): T {
  if (value === null || value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  const candidate = String(value);
  if (!(allowed as readonly string[]).includes(candidate)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return candidate as T;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Human friendly short duration, e.g. 3h, 2d. */
export function ageLabel(fromIso: string, toIso = nowIso()): string {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '?';
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
