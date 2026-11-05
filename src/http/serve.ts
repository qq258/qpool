import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { baseUrl, loadConfig } from '../core/config.ts';
import { openDb } from '../core/db.ts';
import { flushPendingExports } from '../core/export.ts';
import { backupDatabase, latestBackupAgeMs } from '../core/maintenance.ts';
import { PID_FILE } from '../core/service-control.ts';
import { startServer } from './server.ts';

const config = loadConfig();
const db = openDb(config.dbPath);

// Timestamp every lifecycle line: after a host crash the log is the only record of
// when this service started, stopped, or auto-backed-up.
const stamp = () => new Date().toISOString();
const log = (text: string) => process.stdout.write(`${stamp()} ${text}\n`);

// Safety net for a single-file database: keep at most one automatic backup per day.
try {
  const age = latestBackupAgeMs();
  if (age === null || age > 24 * 60 * 60 * 1000) {
    const result = backupDatabase(db, 10);
    log(`[qpool] auto backup: ${result.path}`);
  }
} catch (err) {
  log(`[qpool] auto backup failed: ${(err as Error).message}`);
}

mkdirSync(dirname(PID_FILE), { recursive: true });
writeFileSync(PID_FILE, String(process.pid), 'utf8');

const server = await startServer({ db, config });

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[qpool] ${signal} received, shutting down`);
  try {
    server.close();
  } catch {
    // ignore
  }
  try {
    const flushed = flushPendingExports(db);
    if (flushed > 0) log(`[qpool] flushed ${flushed} pending snapshot(s)`);
  } catch {
    // ignore
  }
  try {
    db.close();
  } catch {
    // ignore
  }
  rmSync(PID_FILE, { force: true });
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log(`[qpool] uncaught: ${err?.stack ?? String(err)}`);
});

log(`[qpool] ready at ${baseUrl(config)}`);
