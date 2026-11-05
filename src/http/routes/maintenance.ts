import { badRequest } from '../../core/errors.ts';
import { backupDatabase, forgetProject, purgeClosedItem, readLog, runDoctor } from '../../core/maintenance.ts';
import { flushPendingExports, scheduleExport } from '../../core/export.ts';
import { requireProjectById } from '../../core/projects.ts';
import type { Router } from '../router.ts';

/**
 * Operator-only maintenance surface. Token-gated like every other write, and
 * deliberately not mirrored as MCP tools so the agent never reaches for delete.
 */
export function registerMaintenanceRoutes(router: Router): void {
  router.post('/api/maintenance/purge', (ctx) => {
    const body = (ctx.body ?? {}) as { item?: string; reason?: string };
    if (!body.item) throw badRequest('item is required');

    const row = ctx.db.prepare(`SELECT project_id FROM items WHERE code = ?`).get(body.item.trim().toUpperCase()) as
      | { project_id: number }
      | undefined;
    const result = purgeClosedItem(ctx.db, body.item, String(body.reason ?? ''));
    if (row) {
      scheduleExport(ctx.db, requireProjectById(ctx.db, row.project_id), ctx.config.exportDebounceMs);
    }
    return result;
  });

  router.post('/api/maintenance/forget-project', (ctx) => {
    const body = (ctx.body ?? {}) as { project?: string; reason?: string };
    if (!body.project) throw badRequest('project is required');
    return forgetProject(ctx.db, body.project, String(body.reason ?? ''));
  });

  router.get('/api/maintenance/log', ({ db }) => ({ entries: readLog(db) }));

  router.post('/api/maintenance/backup', (ctx) => {
    const body = (ctx.body ?? {}) as { keep?: number };
    return backupDatabase(ctx.db, Number(body.keep ?? 10));
  });

  router.get('/api/maintenance/doctor', (ctx) => runDoctor(ctx.db, ctx.config.dbPath));

  /**
   * Graceful self-stop so an upgrade can replace the running code even when the
   * caller cannot signal the process (sandboxes deny kill to foreign pids). The
   * next MCP tool call, or `node src/cli.ts start`, brings it back up.
   */
  router.post('/api/maintenance/shutdown', (ctx) => {
    try {
      flushPendingExports(ctx.db);
    } catch {
      // a snapshot is best effort here; the database itself is already durable
    }
    setTimeout(() => process.exit(0), 120).unref();
    return { ok: true, stopping: true, pid: process.pid };
  });
}
