import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Db } from '../core/db.ts';
import type { QpoolConfig } from '../core/config.ts';
import { QpoolError } from '../core/errors.ts';
import { Router } from './router.ts';
import type { RequestContext } from './router.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerItemRoutes } from './routes/items.ts';
import { registerMaintenanceRoutes } from './routes/maintenance.ts';
import { assertWriteToken, readJsonBody, sendError, sendJson } from './respond.ts';
import { serveStatic } from './static.ts';

export interface AppDeps {
  db: Db;
  config: QpoolConfig;
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const STARTED_AT = Date.now();
const VERSION = '0.1.0';

export function buildRouter(): Router {
  const router = new Router();
  registerProjectRoutes(router);
  registerItemRoutes(router);
  registerMaintenanceRoutes(router);
  return router;
}

export function startServer({ db, config }: AppDeps): Promise<Server> {
  const router = buildRouter();

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
    const pathname = url.pathname;

    if (config.logToStdout) {
      res.on('finish', () => {
        const elapsed = Date.now() - startedAt;
        process.stdout.write(`${new Date().toISOString()} ${method} ${pathname} ${res.statusCode} ${elapsed}ms\n`);
      });
    }

    try {
      if (pathname === '/health') {
        sendJson(res, 200, healthPayload(config, db));
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (WRITE_METHODS.has(method)) assertWriteToken(req.headers, config.writeToken);

        const match = router.match(method, pathname);
        if (!match) {
          sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${pathname}` } });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? undefined : await readJsonBody(req);
        const ctx: RequestContext = {
          db,
          config,
          method,
          pathname,
          query: url.searchParams,
          params: match.params,
          body,
          raw: req,
        };
        const result = await match.handler(ctx);
        sendJson(res, 200, result ?? { ok: true });
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const served = serveStatic(pathname, res, pathname === '/' || pathname === '/index.html');
        if (served) return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (err) {
      if (err instanceof QpoolError) {
        sendError(res, err);
        return;
      }
      process.stderr.write(`[qpool] ${method} ${pathname} failed: ${(err as Error)?.stack ?? String(err)}\n`);
      sendError(res, err);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      process.stdout.write(
        `${new Date().toISOString()} [qpool] listening on http://${config.host}:${config.port} db=${config.dbPath}\n`,
      );
      resolvePromise(server);
    });
  });
}

function healthPayload(config: QpoolConfig, db: Db) {
  let projectCount = 0;
  let itemCount = 0;
  try {
    projectCount = (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    itemCount = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
  } catch {
    // schema not migrated yet; report zeros rather than failing the probe
  }
  return {
    ok: true,
    service: 'qpool',
    version: VERSION,
    pid: process.pid,
    uptimeMs: Date.now() - STARTED_AT,
    host: config.host,
    port: config.port,
    db: config.dbPath,
    projects: projectCount,
    items: itemCount,
  };
}
