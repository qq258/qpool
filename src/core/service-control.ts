import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { PACKAGE_ROOT, baseUrl, loadConfig } from './config.ts';
import type { QpoolConfig } from './config.ts';

export const PID_FILE = join(PACKAGE_ROOT, 'data', 'qpool.pid');
export const LOG_FILE = join(PACKAGE_ROOT, 'logs', 'server.log');
const SERVE_ENTRY = join(PACKAGE_ROOT, 'src', 'http', 'serve.ts');

export async function probe(config: QpoolConfig = loadConfig(), timeoutMs = 800): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(config)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureResult {
  started: boolean;
  url: string;
  pid: number | null;
}

/**
 * Make sure the single writer process is up. DSH starts one MCP process per
 * session, so every one of them funnels through here: first probe, then spawn
 * detached (survives the session), then probe again.
 */
/**
 * Keeps the request log bounded: rotates once it passes `maxBytes` and keeps the
 * newest `keep` rotated files. Returns the rotated path, or null when untouched.
 */
export function rotateLog(file = LOG_FILE, maxBytes = 5 * 1024 * 1024, keep = 3): string | null {
  if (!existsSync(file)) return null;
  if (statSync(file).size <= maxBytes) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let target = `${file}.${stamp}`;
  let counter = 1;
  while (existsSync(target)) {
    target = `${file}.${stamp}-${counter}`;
    counter += 1;
  }
  renameSync(file, target);

  const dir = dirname(file);
  const base = basename(file);
  const rotated = readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.`))
    .sort()
    .reverse();
  for (const name of rotated.slice(keep)) rmSync(join(dir, name), { force: true });
  return target;
}

export async function ensureService(
  config: QpoolConfig = loadConfig(),
  opts: { timeoutMs?: number } = {},
): Promise<EnsureResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  if (await probe(config, 400)) return { started: false, url: baseUrl(config), pid: readPid() };

  mkdirSync(dirname(LOG_FILE), { recursive: true });
  rotateLog();
  const fd = openSync(LOG_FILE, 'a');
  try {
    const child = spawn(process.execPath, [SERVE_ENTRY], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, QPOOL_DETACHED: '1' },
    });
    child.unref();
  } finally {
    closeSync(fd);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(config, 500)) return { started: true, url: baseUrl(config), pid: readPid() };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `qpool service did not become healthy within ${timeoutMs}ms; see ${LOG_FILE} or run "node src/cli.ts start --foreground"`,
  );
}

export async function stopService(config: QpoolConfig = loadConfig()): Promise<boolean> {
  let pid = readPid();

  // The pid file can be missing (hard kill, stale cleanup by another instance);
  // fall back to the pid the service reports about itself.
  if (!pid && (await probe(config, 400))) {
    try {
      const health = (await (
        await fetch(`${baseUrl(config)}/health`, { signal: AbortSignal.timeout(800) })
      ).json()) as { pid?: number };
      if (typeof health.pid === 'number' && health.pid > 0) pid = health.pid;
    } catch {
      // fall through: probe will report what is still running
    }
  }

  if (pid && isAlive(pid)) {
    try {
      process.kill(pid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM') {
        throw new Error(
          `cannot stop pid ${pid}: permission denied (the service was started by a different parent). ` +
            `Run "taskkill /PID ${pid} /F" in a normal terminal, or POST /api/maintenance/shutdown with the write token.`,
        );
      }
      throw err;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  rmSync(PID_FILE, { force: true });
  const stopped = !(await probe(config, 400));
  return stopped;
}
