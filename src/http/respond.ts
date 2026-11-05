import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { QpoolError, badRequest, forbidden } from '../core/errors.ts';

export const JSON_LIMIT_BYTES = 2 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof QpoolError) {
    sendJson(res, err.status, err.toJSON());
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: 'INTERNAL', message, details: null } });
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export function assertWriteToken(headers: IncomingHttpHeaders, expected: string): void {
  const provided = headerValue(headers, 'x-qpool-token');
  if (!provided) throw forbidden('writes require the x-qpool-token header (only the DSH MCP process has it)');
  if (provided.length !== expected.length) throw forbidden('invalid write token');
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) throw forbidden('invalid write token');
}

export async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > JSON_LIMIT_BYTES) throw badRequest(`request body exceeds ${JSON_LIMIT_BYTES} bytes`);
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('request body must be valid JSON');
  }
}
