// Live end-to-end regression against the running service.
// Creates an isolated throwaway project each run, so it never pollutes real pools.
import { readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const base = `http://${config.host}:${config.port}`;

const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
const projectPath = mkdtempSync(join(tmpdir(), 'qpool-e2e-'));
const code = `E2E${suffix}`;

async function call(method, path, body, token = config.writeToken) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET' && token) headers['x-qpool-token'] = token;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail.slice(0, 200)}` : ''}`);
}

try {
  const project = await call('POST', '/api/projects', { path: projectPath, code, name: 'e2e regression' });
  check('register isolated project', project.status === 200 && project.payload.project?.code === code);

  const blocker = await call('POST', '/api/items', {
    project: code,
    kind: 'defect',
    severity: 'blocker',
    title: '父问题：关闭流程需要闭环校验',
    body: '验证子树与签字规则',
  });
  const parentCode = blocker.payload.item?.code;
  check('create blocker parent', blocker.status === 200 && parentCode === `${code}-1`, JSON.stringify(blocker.payload).slice(0, 120));

  const batch = await call('POST', `/api/items/${parentCode}/children`, {
    items: [
      { title: '子问题一：状态机允许非法跳转', severity: 'major' },
      { title: '子问题二：缺少证据仍可关闭', severity: 'minor' },
    ],
  });
  const childCodes = (batch.payload.created ?? []).map((item) => item.code);
  check('decompose into 2 children', batch.status === 200 && childCodes.length === 2, childCodes.join(','));

  const openChildren = await call('POST', `/api/items/${parentCode}/close`, {
    reason: '想直接关父问题',
    evidence: [{ kind: 'test', ref: 'node test/run.ts' }],
  });
  check('parent close blocked by open children', openChildren.status === 409, JSON.stringify(openChildren.payload).slice(0, 140));

  const noEvidence = await call('POST', `/api/items/${childCodes[0]}/close`, { reason: '没有证据' });
  check('close without evidence blocked', noEvidence.status === 409);

  for (const child of childCodes) {
    await call('POST', `/api/items/${child}/evidence`, { kind: 'test', ref: `test/${child}.ts`, note: '用例通过' });
    const closed = await call('POST', `/api/items/${child}/close`, { reason: '已修复并通过用例', close_kind: 'fixed' });
    check(`agent closes child ${child}`, closed.status === 200 && closed.payload.item?.status === 'closed');
  }

  const agentBlocker = await call('POST', `/api/items/${parentCode}/close`, {
    reason: 'agent 想自己关 blocker',
    evidence: [{ kind: 'doc', ref: 'README.md' }],
  });
  check('blocker cannot be closed by agent', agentBlocker.status === 409, JSON.stringify(agentBlocker.payload).slice(0, 140));

  const submit = await call('POST', `/api/items/${parentCode}/submit`, {
    conclusion: '父问题已修复：闭环校验、子树规则、签字门禁全部落地',
    evidence: [{ kind: 'test', ref: 'test/run.ts', note: '25 个用例通过' }],
  });
  check('submit blocker for review', submit.status === 200 && submit.payload.item?.status === 'waiting_review');

  const gateBeforeSignoff = await call('GET', `/api/projects/${code}/gate`);
  check('gate fails while a blocker waits for signoff', gateBeforeSignoff.payload.pass === false);

  const signoff = await call('POST', `/api/items/${parentCode}/signoff`, { decision: 'approve', quote: '同意闭环，我已逐条确认' });
  check('human signoff closes blocker', signoff.status === 200 && signoff.payload.item?.status === 'closed');

  const gate = await call('GET', `/api/projects/${code}/gate`);
  check('gate passes after signoff', gate.payload.pass === true, JSON.stringify(gate.payload).slice(0, 140));

  const brief = await call('GET', `/api/projects/${code}/brief`);
  check('brief counts', brief.payload.counts?.total === 3 && brief.payload.gate?.pass === true, JSON.stringify(brief.payload.counts));

  const tree = await call('GET', `/api/projects/${code}/tree`);
  check('tree shape', tree.payload.roots?.length === 1 && tree.payload.roots[0].children?.length === 2);

  const detail = await call('GET', `/api/items/${parentCode}`);
  check(
    'detail has evidence/events/children',
    detail.payload.evidence?.length >= 1 && detail.payload.events?.length >= 3 && detail.payload.children?.length === 2,
  );

  const search = await call('GET', '/api/search?q=' + encodeURIComponent('闭环校验'));
  check('full text search', search.status === 200 && search.payload.hits?.some((hit) => hit.project_code === code));

  const stale = await call('PATCH', `/api/items/${parentCode}`, { version: 1, title: '并发冲突测试' });
  check('optimistic lock rejects stale version', stale.status === 409);

  const exported = await call('POST', `/api/projects/${code}/export`, {});
  check('export writes snapshots', exported.status === 200 && exported.payload.items === 3, exported.payload.markdown);

  const unauth = await call('POST', '/api/projects', { path: projectPath }, null);
  check('write without token rejected', unauth.status === 403);
} finally {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  // Leave no trace in the registry: this project is throwaway by design.
  try {
    await call('POST', '/api/maintenance/forget-project', {
      project: code,
      reason: '端到端回归的临时项目，用完即删',
    });
  } catch (err) {
    console.error(`cleanup failed: ${err.message}`);
  }
  try {
    rmSync(projectPath, { recursive: true, force: true });
  } catch {
    /* the service may still be writing a snapshot */
  }
  process.exitCode = failed.length ? 1 : 0;
}
