import { mkdtempSync, existsSync, readFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { openDb } from '../src/core/db.ts';
import type { Db } from '../src/core/db.ts';
import { SCHEMA_VERSION } from '../src/core/schema.ts';
import { registerProject, getProjectByCode, setProjectArchived, listProjects } from '../src/core/projects.ts';
import type { ProjectView } from '../src/core/projects.ts';
import {
  addLink,
  attachEvidence,
  claimItem,
  closeItem,
  createChildBatch,
  createItem,
  listItems,
  projectTree,
  releaseItem,
  reopenItem,
  requireItem,
  searchItems,
  showItem,
  signoffItem,
  submitItem,
  updateItem,
} from '../src/core/items.ts';
import { evaluateGate } from '../src/core/gate.ts';
import { exportProject } from '../src/core/export.ts';
import { buildBrief } from '../src/core/brief.ts';
import { forgetProject, purgeClosedItem, backupDatabase, runDoctor } from '../src/core/maintenance.ts';
import { inspectBackup, restoreDatabase } from '../src/core/restore.ts';
import { rotateLog } from '../src/core/service-control.ts';
import { QpoolError } from '../src/core/errors.ts';

let tmp: string;
let db: Db;
let project: ProjectView;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qpool-test-'));
  db = openDb(join(tmp, 'data', 'test.db'));
  project = registerProject(db, { path: tmp, code: 'TEST', name: 'test project' });
});

afterEach(() => {
  db.close();
});

function expectQpoolCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof QpoolError, `expected QpoolError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code} to be thrown`);
}

describe('create + tree', () => {
  it('assigns sequential codes and a materialised path', () => {
    const parent = createItem(db, project, { title: '父问题', kind: 'defect', severity: 'blocker' });
    const { created } = createChildBatch(db, project, parent.code, [
      { title: '子问题一' },
      { title: '子问题二' },
    ]);

    assert.equal(parent.code, 'TEST-1');
    assert.deepEqual(created.map((item) => item.code), ['TEST-2', 'TEST-3']);
    assert.equal(created[0].parent_id, parent.id);
    assert.equal(created[0].depth, 1);
    assert.equal(created[0].path, `/${parent.id}/${created[0].id}/`);

    const tree = projectTree(db, project);
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.roots[0].children.length, 2);
    assert.deepEqual(tree.roots[0].childProgress, { closed: 0, total: 2 });
  });

  it('deduplicates identical client_op_id writes', () => {
    const first = createItem(db, project, { title: '重复提交捕获', clientOpId: 'op-1' });
    const second = createItem(db, project, { title: '重复提交捕获', clientOpId: 'op-1' });
    assert.equal(first.code, second.code);
    assert.equal(listItems(db, project, {}).total, 1);
  });

  it('refuses a child under a closed parent', () => {
    const parent = createItem(db, project, { title: '已关闭的父问题', severity: 'minor' });
    attachEvidence(db, parent.code, { kind: 'test', ref: 'x' });
    closeItem(db, parent.code, { reason: '已处理', close_kind: 'fixed' });
    expectQpoolCode(() => createItem(db, project, { title: '迟到的子问题', parent: parent.code }), 'INVALID_STATE');
  });
});

describe('state machine', () => {
  it('rejects illegal transitions', () => {
    const item = createItem(db, project, { title: '状态机用例' });
    expectQpoolCode(() => updateItem(db, item.code, { status: 'closed' }), 'INVALID_STATE');
    expectQpoolCode(() => updateItem(db, item.code, { status: 'waiting_review' }), 'INVALID_STATE');
    const doing = updateItem(db, item.code, { status: 'in_progress' });
    assert.equal(doing.status, 'in_progress');
    const blocked = updateItem(db, item.code, { status: 'blocked', blockReason: '等依赖' });
    assert.equal(blocked.block_reason, '等依赖');
  });

  it('rejects writes from a stale version', () => {
    const item = createItem(db, project, { title: '并发版本用例' });
    updateItem(db, item.code, { version: 1, title: '改名一次' });
    expectQpoolCode(() => updateItem(db, item.code, { version: 1, title: '改名二次' }), 'CONFLICT');
  });

  it('rejects blocks cycles', () => {
    const first = createItem(db, project, { title: '循环检测 A' });
    const second = createItem(db, project, { title: '循环检测 B' });
    addLink(db, project, first.code, { type: 'blocks', to: second.code });
    expectQpoolCode(() => addLink(db, project, second.code, { type: 'blocks', to: first.code }), 'VALIDATION');
  });
});

describe('closure rules', () => {
  it('requires evidence', () => {
    const item = createItem(db, project, { title: '没有证据的问题' });
    expectQpoolCode(() => closeItem(db, item.code, { reason: '想关就关' }), 'INVALID_STATE');
  });

  it('requires open children to be closed first', () => {
    const parent = createItem(db, project, { title: '非阻塞父问题', severity: 'major' });
    createChildBatch(db, project, parent.code, [{ title: '子问题仍未解决' }]);
    attachEvidence(db, parent.code, { kind: 'doc', ref: 'notes.md' });
    expectQpoolCode(() => closeItem(db, parent.code, { reason: '父问题先关' }), 'INVALID_STATE');
  });

  it('blocks agent closure of a blocker until human signoff', () => {
    const item = createItem(db, project, { title: '阻塞问题', severity: 'blocker' });
    attachEvidence(db, item.code, { kind: 'test', ref: 'test/x' });
    expectQpoolCode(() => closeItem(db, item.code, { reason: '自己关' }), 'INVALID_STATE');

    submitItem(db, item.code, { conclusion: '修复方案已落地', evidence: [{ kind: 'commit', ref: 'abc123' }] });
    assert.equal(requireItem(db, item.code).status, 'waiting_review');
    const signed = signoffItem(db, item.code, { decision: 'approve', quote: '同意，我已复核' });
    assert.equal(signed.status, 'closed');
    assert.equal(signed.closed_by_type, 'human');
    assert.equal(signed.signoff_quote, '同意，我已复核');
    assert.equal(signed.close_kind, 'fixed');
  });

  it('requires a quote to accept risk', () => {
    const item = createItem(db, project, { title: '风险接受用例', severity: 'major' });
    attachEvidence(db, item.code, { kind: 'doc', ref: 'risk.md' });
    submitItem(db, item.code, { conclusion: '暂不处理', closeKind: 'accepted_risk' });
    expectQpoolCode(() => signoffItem(db, item.code, { decision: 'accept_risk', quote: '' }), 'VALIDATION');
    const accepted = signoffItem(db, item.code, { decision: 'accept_risk', quote: '接受风险，后续版本再处理' });
    assert.equal(accepted.close_kind, 'accepted_risk');
    assert.equal(accepted.status, 'closed');
  });

  it('duplicate closure needs a duplicate_of link', () => {
    const original = createItem(db, project, { title: '原始问题' });
    const duplicate = createItem(db, project, { title: '重复问题' });
    attachEvidence(db, duplicate.code, { kind: 'doc', ref: 'see original' });
    expectQpoolCode(
      () => closeItem(db, duplicate.code, { reason: '与原始问题重复', closeKind: 'duplicate' }),
      'INVALID_STATE',
    );
    assert.equal(original.code, 'TEST-1');
  });

  it('reopen clears closure fields and keeps the audit trail', () => {
    const item = createItem(db, project, { title: '重开用例' });
    attachEvidence(db, item.code, { kind: 'test', ref: 'x' });
    closeItem(db, item.code, { reason: '已修复' });
    const reopened = reopenItem(db, item.code, '回归测试又挂了');
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.close_kind, null);
    assert.equal(showItem(db, item.code).events.length >= 3, true);
  });
});

describe('gate', () => {
  it('fails while anything is open and passes once everything is closed', () => {
    const blocker = createItem(db, project, { title: '必须人类签字的阻塞问题', severity: 'blocker' });
    const minor = createItem(db, project, { title: '小问题', severity: 'minor' });

    let gate = evaluateGate(db, project);
    assert.equal(gate.pass, false);
    assert.equal(gate.open, 2);
    assert.ok(gate.reasons.some((reason) => reason.includes('open')));

    attachEvidence(db, minor.code, { kind: 'test', ref: 'x' });
    closeItem(db, minor.code, { reason: '已修复' });

    attachEvidence(db, blocker.code, { kind: 'test', ref: 'x' });
    submitItem(db, blocker.code, { conclusion: '已修复等待验收' });
    gate = evaluateGate(db, project);
    assert.equal(gate.pass, false);
    assert.equal(gate.waiting_review.length, 1);

    signoffItem(db, blocker.code, { decision: 'approve', quote: '确认通过' });
    gate = evaluateGate(db, project);
    assert.equal(gate.pass, true);
    assert.deepEqual(gate.reasons, []);
  });

  it('surfaces risk-accepted items separately', () => {
    const item = createItem(db, project, { title: '带风险放行', severity: 'major' });
    attachEvidence(db, item.code, { kind: 'doc', ref: 'risk.md' });
    submitItem(db, item.code, { conclusion: '接受风险', closeKind: 'accepted_risk' });
    signoffItem(db, item.code, { decision: 'accept_risk', quote: '接受风险，我来兜底' });
    const gate = evaluateGate(db, project);
    assert.equal(gate.pass, true);
    assert.equal(gate.accepted_risk.length, 1);
  });
});

describe('project freeze', () => {
  it('freezes only when everything is closed, then rejects writes', () => {
    const item = createItem(db, project, { title: '冻结前的问题' });
    expectQpoolCode(() => setProjectArchived(db, 'TEST', true, '还开着'), 'INVALID_STATE');

    attachEvidence(db, item.code, { kind: 'doc', ref: 'notes.md' });
    closeItem(db, item.code, { reason: '处理完毕' });

    const frozen = setProjectArchived(db, 'TEST', true, '项目完成，封存');
    assert.equal(frozen.frozen, true);
    assert.equal(getProjectByCode(db, 'TEST')?.status, 'archived');

    expectQpoolCode(() => createItem(db, project, { title: '冻结后新问题' }), 'INVALID_STATE');
    expectQpoolCode(() => setProjectArchived(db, 'TEST', true), 'INVALID_STATE');

    const thawed = setProjectArchived(db, 'TEST', false, '需要补录一个问题');
    assert.equal(thawed.frozen, false);
    const created = createItem(db, project, { title: '解冻后可以继续记录' });
    assert.equal(created.code, 'TEST-2');
  });
});

describe('maintenance', () => {
  it('purges only closed items and records why', () => {
    const item = createItem(db, project, { title: '误录的测试记录' });
    expectQpoolCode(() => purgeClosedItem(db, item.code, '测试数据'), 'INVALID_STATE');

    attachEvidence(db, item.code, { kind: 'doc', ref: 'n/a' });
    closeItem(db, item.code, { reason: '确认是误录' });
    const result = purgeClosedItem(db, item.code, '测试数据，清理');
    assert.equal(result.purged, true);
    expectQpoolCode(() => requireItem(db, item.code), 'NOT_FOUND');

    const events = db.prepare(`SELECT action, payload FROM events WHERE project_id = ? ORDER BY id DESC`).all(project.id) as Array<{
      action: string;
      payload: string;
    }>;
    assert.equal(events[0].action, 'purge');
    assert.match(events[0].payload, /测试数据/);
  });

  it('refuses to forget a project that still has open items', () => {
    createItem(db, project, { title: '还开着的问题' });
    expectQpoolCode(() => forgetProject(db, 'TEST', '临时项目'), 'INVALID_STATE');
  });

  it('backs up the database and prunes older copies', () => {
    const dir = join(tmp, 'backups');
    const first = backupDatabase(db, 2, dir);
    assert.ok(existsSync(first.path));
    assert.ok(first.bytes > 0);

    backupDatabase(db, 2, dir);
    const third = backupDatabase(db, 2, dir);
    assert.equal(third.removed.length, 1, 'keep=2 should prune the oldest');
    assert.equal(readdirSync(dir).filter((name) => name.endsWith('.db')).length, 2);
  });

  it('doctor reports integrity and flags a vanished project root', () => {    const healthy = runDoctor(db, join(tmp, 'data', 'test.db'), join(tmp, 'backups'));
    assert.equal(healthy.db.integrity, 'ok');
    assert.equal(healthy.ok, true);

    const gone = join(tmp, 'gone');
    mkdirSync(gone, { recursive: true });
    registerProject(db, { path: gone, code: 'GONE', name: 'will vanish' });
    rmSync(gone, { recursive: true, force: true });

    const report = runDoctor(db, join(tmp, 'data', 'test.db'), join(tmp, 'backups'));
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.includes('root directory is gone')));
  });

  it('rotates an oversized log and keeps only the newest copies', () => {
    const dir = join(tmp, 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'server.log');

    writeFileSync(file, 'x'.repeat(2048));
    const first = rotateLog(file, 1024, 2);
    assert.ok(first && existsSync(first), 'oversized log should be rotated');
    assert.equal(existsSync(file), false);

    for (let index = 0; index < 3; index += 1) {
      writeFileSync(file, 'x'.repeat(2048));
      rotateLog(file, 1024, 2);
    }
    const rotated = readdirSync(dir).filter((name) => name.startsWith('server.log.'));
    assert.equal(rotated.length, 2, 'keep=2 should prune older rotations');

    writeFileSync(file, 'tiny');
    assert.equal(rotateLog(file, 1024, 2), null);
  });
});

describe('backup restore', () => {
  it('reverts the live database to a backup and keeps the replaced file', () => {
    const work = mkdtempSync(join(tmpdir(), 'qpool-restore-'));
    const live = join(work, 'live.db');
    const dirA = join(work, 'project-a');
    const dirB = join(work, 'project-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const first = openDb(live);
    registerProject(first, { path: dirA, code: 'RSTA', name: 'before backup' });
    const backup = backupDatabase(first, 5, join(work, 'backups'));
    registerProject(first, { path: dirB, code: 'RSTB', name: 'after backup' });
    assert.equal(listProjects(first).length, 2);
    first.close();

    const info = inspectBackup(backup.path);
    assert.equal(info.ok, true);
    assert.equal(info.projects, 1, 'the backup predates the second project');

    const result = restoreDatabase(backup.path, live, { currentSchema: SCHEMA_VERSION });
    assert.ok(result.previous && existsSync(result.previous), 'the replaced database must be kept');

    const second = openDb(live);
    const codes = listProjects(second).map((project) => project.code);
    second.close();
    assert.deepEqual(codes, ['RSTA']);

    expectQpoolCode(() => restoreDatabase(live, live), 'VALIDATION');
    expectQpoolCode(() => inspectBackup(join(work, 'nope.db')), 'NOT_FOUND');

    const notSqlite = join(work, 'notes.txt');
    writeFileSync(notSqlite, 'this is definitely not a database');
    expectQpoolCode(() => inspectBackup(notSqlite), 'VALIDATION');
  });
});

describe('schema migration', () => {
  it('re-adds the claim columns to a v1 database', () => {
    const work = mkdtempSync(join(tmpdir(), 'qpool-migrate-'));
    const file = join(work, 'v1.db');

    const first = openDb(file);
    first.exec('ALTER TABLE items DROP COLUMN claimed_by');
    first.exec('ALTER TABLE items DROP COLUMN claimed_at');
    first.prepare(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`).run();
    first.close();

    const second = openDb(file);
    const columns = (second.prepare(`PRAGMA table_info('items')`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    const version = (second.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string })
      .value;
    second.close();

    assert.ok(columns.includes('claimed_by'), 'claimed_by should be re-added');
    assert.ok(columns.includes('claimed_at'), 'claimed_at should be re-added');
    assert.equal(version, String(SCHEMA_VERSION));
  });
});

describe('cross-session claims', () => {
  it('lets one conversation claim and blocks the other', () => {
    const item = createItem(db, project, { title: '锁定用例' });
    const claimed = claimItem(db, item.code, 'mcp-111');
    assert.equal(claimed.item.claimed_by, 'mcp-111');

    expectQpoolCode(() => claimItem(db, item.code, 'mcp-222'), 'INVALID_STATE');

    const same = claimItem(db, item.code, 'mcp-111');
    assert.equal(same.taken_over_from, null, 're-claiming your own lock is not a takeover');

    const released = releaseItem(db, item.code, 'mcp-111');
    assert.equal(released.claimed_by, null);
    assert.equal(claimItem(db, item.code, 'mcp-222').item.claimed_by, 'mcp-222');
  });

  it('takes over a claim that outlived the TTL', () => {
    const item = createItem(db, project, { title: '过期锁定用例' });
    claimItem(db, item.code, 'mcp-old');
    db.prepare(`UPDATE items SET claimed_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      item.id,
    );

    const taken = claimItem(db, item.code, 'mcp-new');
    assert.equal(taken.taken_over_from, 'mcp-old');
    assert.equal(taken.item.claimed_by, 'mcp-new');
  });

  it('refuses to claim closed work and releases on close', () => {
    const item = createItem(db, project, { title: '关闭后释放锁定' });
    claimItem(db, item.code, 'mcp-111');
    attachEvidence(db, item.code, { kind: 'test', ref: 'x' });
    const closed = closeItem(db, item.code, { reason: '已修复', closeKind: 'fixed' });
    assert.equal(closed.claimed_by, null, 'closing must drop the claim');

    expectQpoolCode(() => claimItem(db, item.code, 'mcp-222'), 'INVALID_STATE');
  });

  it('only the holder (or a forced release) can unlock', () => {
    const item = createItem(db, project, { title: '释放权限用例' });
    claimItem(db, item.code, 'mcp-111');
    expectQpoolCode(() => releaseItem(db, item.code, 'mcp-222'), 'INVALID_STATE');
    assert.equal(releaseItem(db, item.code, 'mcp-222', true).claimed_by, null);
  });

  it('reports per-project lock counts from another session', () => {
    const item = createItem(db, project, { title: '项目锁定统计' });
    claimItem(db, item.code, 'mcp-111');

    const mine = listProjects(db, { sessionId: 'mcp-111' })[0];
    assert.equal(mine?.claimed_total, 1);
    assert.equal(mine?.claimed_other, 0, 'my own claim is not "other"');

    const other = listProjects(db, { sessionId: 'mcp-999' })[0];
    assert.equal(other?.claimed_other, 1);
    assert.equal(other?.claimed_sessions, 1);
    assert.deepEqual(other?.claimed_other_codes, [item.code]);
  });
});

describe('search / brief / export', () => {
  it('finds items by substring across the pool', () => {
    createItem(db, project, { title: '签名校验缺少边界检查', body: '签名字节长度不一致时会抛异常' });
    const hits = searchItems(db, '签名校验');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].project_code, 'TEST');
  });

  it('brief puts waiting-review first', () => {
    const item = createItem(db, project, { title: '待签字问题', severity: 'blocker' });
    attachEvidence(db, item.code, { kind: 'test', ref: 'x' });
    submitItem(db, item.code, { conclusion: '等待签字' });
    const brief = buildBrief(db, project);
    assert.equal(brief.counts.waiting_review, 1);
    assert.equal(brief.needs_owner.length, 1);
    assert.equal(brief.gate.pass, false);
  });

  it('exports jsonl and markdown snapshots into the project', () => {
    const item = createItem(db, project, { title: '快照导出用例', body: '正文' });
    attachEvidence(db, item.code, { kind: 'file', ref: 'src/a.ts:12' });
    const result = exportProject(db, project);
    assert.ok(existsSync(result.jsonl));
    assert.ok(existsSync(result.markdown));
    const lines = readFileSync(result.jsonl, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as { code: string; evidence: unknown[] };
    assert.equal(parsed.code, item.code);
    assert.equal(parsed.evidence.length, 1);
    assert.match(readFileSync(result.markdown, 'utf8'), /快照导出用例/u);
  });
});
