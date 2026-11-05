// Exercises the 13 MCP tool handlers end to end: tool schema -> HTTP -> SQLite.
// The handlers are plain functions, so no child process (and no piped stdio) is needed.
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
import { ApiClient } from '../src/mcp/api.ts';
import { TOOLS } from '../src/mcp/tools.ts';
import type { ToolDefinition } from '../src/mcp/tools.ts';

let tmp: string;
let db: Db;
let server: Server;
let client: ApiClient;
let projectPath: string;

const TOKEN = 'mcp-test-token';

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'qpool-mcp-'));
  projectPath = join(tmp, 'demo');
  mkdirSync(projectPath, { recursive: true });
  db = openDb(join(tmp, 'data', 'mcp.db'));

  const config: QpoolConfig = {
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmp, 'data', 'mcp.db'),
    writeToken: TOKEN,
    exportDebounceMs: 30,
    logToStdout: false,
  };
  server = await startServer({ db, config });
  const address = server.address() as AddressInfo;
  client = new ApiClient({ ...config, port: address.port }, { sessionId: 'test-session' });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

function tool(name: string): ToolDefinition {
  const found = TOOLS.find((entry) => entry.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  return tool(name).handler(client, args);
}

describe('mcp tool surface', () => {
  it('exposes every tool with a schema and description', () => {
    assert.equal(TOOLS.length, 15, `expected 15 tools, got ${TOOLS.map((entry) => entry.name).join(',')}`);
    for (const entry of TOOLS) {
      assert.match(entry.name, /^q_[a-z_]+$/);
      assert.ok(entry.description.length > 10, `${entry.name} needs a description`);
      assert.equal((entry.inputSchema as { type?: string }).type, 'object');
    }
  });

  it('registers a project and reports it in q_projects / q_brief', async () => {
    const empty = await call('q_projects', {});
    assert.match(empty, /还没有注册任何项目/);

    const registered = await call('q_projects', { action: 'init', path: projectPath, code: 'MCP', name: 'mcp test' });
    assert.match(registered, /已注册 MCP/);

    const brief = await call('q_brief', {});
    assert.match(brief, /MCP/);
    assert.match(await call('q_brief', { project: 'MCP' }), /gate: PASS/);
  });

  it('creates, decomposes, lists and shows problems', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });

    const created = await call('q_create', {
      project: 'MCP',
      title: '父问题：MCP 工具能否完成闭环',
      severity: 'blocker',
      kind: 'requirement',
      body: '验证工具面',
    });
    assert.match(created, /已记录 MCP-1/);

    const batch = await call('q_create_batch', {
      parent: 'MCP-1',
      items: [{ title: '子问题一' }, { title: '子问题二', severity: 'minor' }],
    });
    assert.match(batch, /MCP-2/);
    assert.match(batch, /MCP-3/);

    const listed = await call('q_list', { project: 'MCP' });
    assert.match(listed, /MCP-2/);
    assert.match(listed, /3 条/);

    const shown = await call('q_show', { item: 'MCP-1' });
    assert.match(shown, /version 1/);
    assert.match(shown, /子问题 \(0\/2 已闭环\)/);
  });

  it('renders the project table with the lock column', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });
    await call('q_create', { project: 'MCP', title: '表格与锁定用例' });
    await call('q_claim', { item: 'MCP-1' });

    const mine = await call('q_projects', {});
    assert.match(mine, /其他对话锁定/, 'table needs the lock column');
    assert.match(mine, /本对话/, 'own claim shows as 本对话');
    assert.match(mine, /MCP/);

    const otherClient = new ApiClient(client.config, { sessionId: 'other-session' });
    const otherTable = await tool('q_projects').handler(otherClient, {});
    assert.match(otherTable, /1 项（1 个对话）/, 'another conversation sees the lock');

    await assert.rejects(
      () => tool('q_claim').handler(otherClient, { item: 'MCP-1' }),
      /locked by another conversation/,
    );
    await assert.rejects(
      () => tool('q_release').handler(otherClient, { item: 'MCP-1' }),
      /locked by @test-session/,
    );

    const shown = await call('q_show', { item: 'MCP-1' });
    assert.match(shown, /锁定: @test-session/);
  });

  it('runs the full closure path for a non-blocker', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });
    const created = await call('q_create', { project: 'MCP', title: '普通缺陷', severity: 'major' });
    const code = /MCP-\d+/.exec(created)?.[0] ?? '';

    await call('q_evidence', { item: code, kind: 'test', ref: 'node test/run.ts', note: '用例通过' });
    const closed = await call('q_close', { item: code, reason: '已修复并通过用例', close_kind: 'fixed' });
    assert.match(closed, /已闭环/);

    const gate = await call('q_gate', { project: 'MCP' });
    assert.match(gate, /GATE MCP: PASS/);
  });

  it('refuses to let the agent close a blocker', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });
    await call('q_create', { project: 'MCP', title: '阻塞缺陷', severity: 'blocker' });
    await call('q_evidence', { item: 'MCP-1', kind: 'test', ref: 'x' });
    await assert.rejects(
      () => call('q_close', { item: 'MCP-1', reason: '想自己关' }),
      /human signoff|blocker/,
    );

    await call('q_submit', { item: 'MCP-1', conclusion: '已修复，等待验收' });
    await assert.rejects(() => call('q_signoff', { item: 'MCP-1', decision: 'approve', quote: '' }), /quote|原话|required/);
    const signed = await call('q_signoff', { item: 'MCP-1', decision: 'approve', quote: '我确认闭环' });
    assert.match(signed, /已闭环/);
  });

  it('links problems and blocks cycles', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });
    await call('q_create', { project: 'MCP', title: '上游问题' });
    await call('q_create', { project: 'MCP', title: '下游问题' });

    const linked = await call('q_link', { item: 'MCP-1', type: 'blocks', to: 'MCP-2' });
    assert.match(linked, /已建立关联/);
    await assert.rejects(() => call('q_link', { item: 'MCP-2', type: 'blocks', to: 'MCP-1' }), /cycle/);

    const shown = await call('q_show', { item: 'MCP-2' });
    assert.match(shown, /被这些未闭环问题阻塞/);
  });

  it('updates fields with the version guard', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });
    await call('q_create', { project: 'MCP', title: '要改的问题' });

    const updated = await call('q_update', { item: 'MCP-1', version: 1, status: 'in_progress', severity: 'blocker' });
    assert.match(updated, /doing\/BLOCKER/);
    await assert.rejects(() => call('q_update', { item: 'MCP-1', version: 1, title: '过期版本' }), /changed since you read/i);
  });

  it('freezes a finished project and rejects later writes', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });
    await call('q_create', { project: 'MCP', title: '唯一的问题' });
    await call('q_evidence', { item: 'MCP-1', kind: 'doc', ref: 'notes.md' });
    await call('q_close', { item: 'MCP-1', reason: '已处理' });

    const frozen = await call('q_projects', { action: 'archive', project: 'MCP', reason: '验收通过' });
    assert.match(frozen, /已冻结/);
    await assert.rejects(() => call('q_create', { project: 'MCP', title: '冻结后新问题' }), /frozen|archived/);
    assert.match(await call('q_brief', { project: 'MCP' }), /已冻结/);

    const thawed = await call('q_projects', { action: 'unarchive', project: 'MCP' });
    assert.match(thawed, /已解冻/);
    assert.match(await call('q_create', { project: 'MCP', title: '解冻后可以继续' }), /已记录/);
  });

  it('refuses to freeze while items are open', async () => {
    await call('q_projects', { action: 'init', path: projectPath, code: 'MCP' });
    await call('q_create', { project: 'MCP', title: '还没解决' });
    await assert.rejects(() => call('q_projects', { action: 'archive', project: 'MCP' }), /open item/);
  });
});
