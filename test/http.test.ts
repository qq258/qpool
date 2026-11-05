import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import type { QpoolConfig } from '../src/core/config.ts';
import { startServer } from '../src/http/server.ts';

const TOKEN = 'test-token';

let tmp: string;
let db: Db;
let server: Server;
let base: string;
let projectPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'qpool-http-'));
  projectPath = join(tmp, 'demo-project');
  mkdirSync(projectPath, { recursive: true });
  db = openDb(join(tmp, 'data', 'http.db'));

  const config: QpoolConfig = {
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmp, 'data', 'http.db'),
    writeToken: TOKEN,
    exportDebounceMs: 30,
    logToStdout: false,
  };
  server = await startServer({ db, config });
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

interface CallResult {
  status: number;
  body: any;
}

async function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<CallResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-qpool-token'] = token;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function register(): Promise<void> {
  const result = await call('POST', '/api/projects', { path: projectPath, code: 'HTTP', name: 'http test' });
  assert.equal(result.status, 200);
}

describe('http surface', () => {
  it('serves health without a token', async () => {
    const result = await call('GET', '/health', undefined, null);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.service, 'qpool');
  });

  it('rejects writes without the token', async () => {
    const result = await call('POST', '/api/projects', { path: projectPath }, null);
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'FORBIDDEN');
  });

  it('registers a project, creates and lists items', async () => {
    await register();
    const created = await call('POST', '/api/items', { project: 'HTTP', title: '接口层创建问题', severity: 'major' });
    assert.equal(created.status, 200);
    assert.equal(created.body.item.code, 'HTTP-1');

    const listed = await call('GET', '/api/projects/HTTP/items');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.total, 1);
  });

  it('is idempotent on client_op_id', async () => {
    await register();
    const first = await call('POST', '/api/items', { project: 'HTTP', title: '幂等创建', client_op_id: 'op-1' });
    const second = await call('POST', '/api/items', { project: 'HTTP', title: '幂等创建', client_op_id: 'op-1' });
    assert.equal(first.body.item.code, second.body.item.code);
    const listed = await call('GET', '/api/projects/HTTP/items');
    assert.equal(listed.body.items.length, 1);
  });

  it('refuses a close without evidence and allows it afterwards', async () => {
    await register();
    const created = await call('POST', '/api/items', { project: 'HTTP', title: '关闭校验' });
    const code = created.body.item.code;

    const denied = await call('POST', `/api/items/${code}/close`, { reason: '没有证据就关' });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'INVALID_STATE');

    await call('POST', `/api/items/${code}/evidence`, { kind: 'test', ref: 'node test/http.test.ts' });
    const ok = await call('POST', `/api/items/${code}/close`, { reason: '用例已覆盖' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.item.status, 'closed');
  });

  it('returns 404 for an unknown item and a helpful gate', async () => {
    await register();
    const missing = await call('GET', '/api/items/HTTP-999');
    assert.equal(missing.status, 404);

    const gate = await call('GET', '/api/projects/HTTP/gate');
    assert.equal(gate.status, 200);
    assert.equal(gate.body.pass, true);
  });

  it('paginates with an opaque cursor', async () => {
    await register();
    for (let index = 0; index < 3; index += 1) {
      await call('POST', '/api/items', { project: 'HTTP', title: `分页用例 ${index}` });
    }
    const first = await call('GET', '/api/projects/HTTP/items?limit=2');
    assert.equal(first.body.items.length, 2);
    assert.ok(first.body.nextCursor);

    const second = await call('GET', `/api/projects/HTTP/items?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    assert.equal(second.body.items.length, 1);
    assert.equal(second.body.nextCursor, null);
  });

  it('serialises concurrent creates into unique codes', async () => {
    await register();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        call('POST', '/api/items', { project: 'HTTP', title: `并发创建 ${index}` }),
      ),
    );
    const codes = results.map((result) => result.body.item.code as string);
    assert.equal(new Set(codes).size, 10, 'every concurrent create must get its own code');
    const listed = await call('GET', '/api/projects/HTTP/items?limit=50');
    assert.equal(listed.body.items.length, 10);
  });

  it('exposes the doctor report', async () => {
    await register();
    const doctor = await call('GET', '/api/maintenance/doctor', undefined, null);
    assert.equal(doctor.status, 200);
    assert.equal(doctor.body.db.integrity, 'ok');
    assert.equal(doctor.body.counts.projects, 1);
  });

  it('serves the read-only console', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<title>qpool/);
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
  });
});
