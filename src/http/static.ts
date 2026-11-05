import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { PACKAGE_ROOT } from '../core/config.ts';

const WEB_ROOT = join(PACKAGE_ROOT, 'src', 'web');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Serves the read-only console from src/web. Returns false when nothing matched so
 * the caller can fall back to a 404 (or the SPA entry point).
 */
export function serveStatic(pathname: string, res: ServerResponse, spaFallback: boolean): boolean {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = resolve(WEB_ROOT, normalize(relative));

  if (!candidate.startsWith(WEB_ROOT + sep) && candidate !== WEB_ROOT) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return true;
  }

  const file = pickFile(candidate) ?? (spaFallback ? pickFile(join(WEB_ROOT, 'index.html')) : null);
  if (!file) return false;

  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
  return true;
}

function pickFile(candidate: string): string | null {
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  const withHtml = `${candidate}.html`;
  if (existsSync(withHtml) && statSync(withHtml).isFile()) return withHtml;
  return null;
}
