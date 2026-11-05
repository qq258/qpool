import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomHex } from './util.ts';

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_PATH = join(PACKAGE_ROOT, 'config.json');

export interface QpoolConfig {
  host: string;
  port: number;
  dbPath: string;
  writeToken: string;
  exportDebounceMs: number;
  logToStdout: boolean;
}

const DEFAULTS: QpoolConfig = {
  host: '127.0.0.1',
  port: 7817,
  dbPath: 'data/qpool.db',
  writeToken: '',
  exportDebounceMs: 1500,
  logToStdout: true,
};

let cached: QpoolConfig | null = null;

/**
 * Loads config.json from the package root, creating it (and a random local write
 * token) on first run. The token is only ever handed to the MCP process; the
 * browser console is read-only by construction.
 */
export function loadConfig(): QpoolConfig {
  if (cached) return cached;

  let fileConfig: Partial<QpoolConfig> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<QpoolConfig>;
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
    }
  }

  const merged: QpoolConfig = { ...DEFAULTS, ...fileConfig };
  merged.port = Number(merged.port) || DEFAULTS.port;
  merged.exportDebounceMs = Number(merged.exportDebounceMs) || DEFAULTS.exportDebounceMs;
  merged.dbPath = isAbsolute(merged.dbPath) ? merged.dbPath : join(PACKAGE_ROOT, merged.dbPath);

  if (!merged.writeToken) {
    merged.writeToken = randomHex(24);
    persist(merged);
  } else if (!existsSync(CONFIG_PATH)) {
    persist(merged);
  }

  cached = merged;
  return merged;
}

function persist(config: QpoolConfig): void {
  mkdirSync(PACKAGE_ROOT, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function baseUrl(config: QpoolConfig = loadConfig()): string {
  return `http://${config.host}:${config.port}`;
}
