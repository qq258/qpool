// Proves the promise behind qpool: several DSH sessions (each with its own MCP
// process) share one issue pool without losing or duplicating writes.
// Child processes are started with file redirection instead of pipes, so this
// also runs inside the DSH sandbox.
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const base = `http://${config.host}:${config.port}`;
const headers = { 'content-type': 'application/json', 'x-qpool-token': config.writeToken };

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: method === 'GET' ? {} : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
const code = `CONC${suffix}`;
const projectDir = mkdtempSync(join(tmpdir(), 'qpool-conc-'));
const fixtureDir = mkdtempSync(join(tmpdir(), 'qpool-conc-fix-'));

const SESSIONS = 3;

function runSession(index) {
  const fixture = join(fixtureDir, `session-${index}.jsonl`);
  const out = join(fixtureDir, `session-${index}.out`);
  const lines = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: `s${index}`, version: '0' } },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'q_create',
        arguments: {
          project: code,
          title: `会话 ${index} 记录的问题`,
          severity: 'minor',
          client_op_id: `conc-${index}`,
        },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'q_brief', arguments: { project: code } } }),
  ];
  writeFileSync(fixture, `${lines.join('\n')}\n`, 'utf8');

  // Redirection via descriptors, not pipes: pipes are blocked in the DSH sandbox.
  const inFd = openSync(fixture, 'r');
  const outFd = openSync(out, 'w');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/mcp/server.ts'], {
      cwd: root,
      stdio: [inFd, outFd, 'ignore'],
      windowsHide: true,
    });
    closeSync(inFd);
    closeSync(outFd);
    child.on('exit', (exitCode) => resolve({ index, exitCode, out, pid: child.pid }));
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

try {
  const registered = await call('POST', '/api/projects', { path: projectDir, code, name: 'concurrency drill' });
  check('register drill project', registered.status === 200, code);

  const runs = await Promise.all(Array.from({ length: SESSIONS }, (_, index) => runSession(index)));
  const created = runs.map((run) => {
    const text = readFileSync(run.out, 'utf8');
    const match = text.match(new RegExp(`${code}-(\\d+)`));
    return { exitCode: run.exitCode, code: match ? `${code}-${match[1]}` : null, text };
  });

  check('every MCP process exited cleanly', created.every((entry) => entry.exitCode === 0), created.map((entry) => entry.exitCode).join(','));
  check('every session got a problem code', created.every((entry) => entry.code), created.map((entry) => entry.code).join(','));
  check(
    'codes are unique across sessions',
    new Set(created.map((entry) => entry.code)).size === SESSIONS,
    created.map((entry) => entry.code).join(','),
  );

  const listed = await call('GET', `/api/projects/${code}/items?limit=50`);
  check('all three writes landed in one pool', listed.body?.items?.length === SESSIONS, `items=${listed.body?.items?.length}`);

  const brief = await call('GET', `/api/projects/${code}/brief`);
  check('shared pool is visible from any session', brief.body?.counts?.total === SESSIONS, JSON.stringify(brief.body?.counts));

  // Each write must carry the identity of the MCP process (one process = one session).
  const sessions = [];
  for (const item of listed.body?.items ?? []) {
    const detail = await call('GET', `/api/items/${item.code}`);
    const event = detail.body?.events?.find((entry) => entry.action === 'create');
    sessions.push(event?.session_id ?? null);
  }
  const expected = new Set(runs.map((run) => `mcp-${run.pid}`));
  check(
    'audit attributes each write to its own MCP session',
    sessions.every((id) => typeof id === 'string' && id.startsWith('mcp-')) && new Set(sessions).size === SESSIONS,
    sessions.join(','),
  );
  check(
    'session ids match the spawned processes',
    sessions.every((id) => expected.has(id)),
    [...expected].join(','),
  );
} finally {
  try {
    // Close what the drill created, otherwise the project cannot be forgotten.
    const listed = await call('GET', `/api/projects/${code}/items?limit=50`);
    for (const item of listed.body?.items ?? []) {
      await call('POST', `/api/items/${item.code}/evidence`, {
        kind: 'test',
        ref: 'scripts/mcp-concurrency.mjs',
        note: '并发演练记录',
      });
      await call('POST', `/api/items/${item.code}/close`, {
        reason: '并发演练产生的临时问题，演练结束即关闭',
        close_kind: 'wontfix',
      });
    }
    await call('POST', '/api/maintenance/forget-project', { project: code, reason: '并发演练的临时项目' });
  } catch (err) {
    console.error(`cleanup failed: ${err.message}`);
  }
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
