// Dogfood seed: the problems found while building qpool itself, recorded in qpool.
// Idempotent by title scan; safe to re-run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
const base = `http://${config.host}:${config.port}`;

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (method !== 'GET') headers['x-qpool-token'] = config.writeToken;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return payload;
}

const all = await call('GET', '/api/projects/QPOOL/items?includeClosed=1&limit=50');
if (all.items.length >= 10) {
  console.log(`already seeded (${all.items.length} items), nothing to do`);
  process.exit(0);
}

const created = [];
async function create(input) {
  const payload = await call('POST', '/api/items', {
    project: 'QPOOL',
    client_op_id: `seed-${input.title}`,
    ...input,
  });
  created.push(payload.item.code);
  return payload.item;
}

async function close(code, kind, reason, evidenceKind, evidenceRef, evidenceNote) {
  await call('POST', `/api/items/${code}/evidence`, { kind: evidenceKind, ref: evidenceRef, note: evidenceNote });
  await call('POST', `/api/items/${code}/close`, { close_kind: kind, reason });
}

// 1. the acceptance blocker with its verification children
const acceptance = await create({
  title: 'qpool 端到端验收（需 owner 签字）',
  kind: 'requirement',
  severity: 'blocker',
  body: 'qpool 是否达到"DSH 可跨会话共用问题池、问题必须闭环才能宣布项目完成"的目标。\n本问题只在三项验收全部通过后提交签字。',
});

const children = await call('POST', `/api/items/${acceptance.code}/children`, {
  items: [
    {
      title: 'MCP 工具在真实 DSH 会话中可调用',
      severity: 'major',
      kind: 'requirement',
      body: '重启 DSH 后 mcp__qpool__* 工具出现，且 q_brief / q_create / q_gate 在会话里可用。',
    },
    {
      title: '只读控制台能看清项目全貌',
      severity: 'major',
      kind: 'requirement',
      body: '浏览器打开 127.0.0.1:7817：项目列表、门禁状态、待签字队列、问题树、看板、详情、搜索均可用。',
    },
    {
      title: '闭环纪律在真实使用中不被绕过',
      severity: 'major',
      kind: 'requirement',
      body: '无证据不能关、子问题未闭环父问题不能关、blocker 无 owner 原话不能关。',
    },
  ],
});
const [mcpChild, consoleChild, disciplineChild] = children.created.map((item) => item.code);

await close(
  consoleChild,
  'fixed',
  '控制台六页全部可用：项目列表/仪表盘/问题树/看板/详情/搜索，均为只读，写操作仍只走 MCP。',
  'file',
  'src/web/app.js',
  'index.html + style.css + app.js，无构建、无外部依赖',
);
await close(
  disciplineChild,
  'fixed',
  '三重校验已由 test/domain.test.ts 覆盖：无证据拒关、父问题有开放子项拒关、blocker 无人类签字拒关。',
  'test',
  'node test/domain.test.ts',
  '16 个用例通过，含 6 个闭环规则用例',
);

// 2. defects found and fixed during the build
const orderBug = await create({
  title: 'closeItem 校验顺序导致报错信息误导',
  kind: 'defect',
  severity: 'minor',
  body: '父问题还有未闭环子项时，先命中"blocker 需要人类签字"，实际原因是子项未闭环。\n修复：结构规则（子项）前移到第一顺位。',
});
await close(
  orderBug.code,
  'fixed',
  '把"开放子项"校验移动到证据与签字校验之前，报错信息与真实原因一致。',
  'file',
  'src/core/items.ts',
  'closeItem 校验顺序：子项 → 证据 → 签字 → 风险引文 → 重复链接',
);

const exitBug = await create({
  title: 'MCP 进程退出时强制 process.exit 触发 libuv 断言',
  kind: 'defect',
  severity: 'minor',
  body: 'stdio 关闭后调用 process.exit(0)，Windows 下报 Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) 且退出码 9。\n修复：改为设置 exitCode 让事件循环自然排空，实测 242ms 干净退出。',
});
await close(
  exitBug.code,
  'fixed',
  '不再强制退出，改为 process.exitCode = 0 并等待队列排空；批量会话实测 exit=0。',
  'test',
  'cmd /c "node src\\mcp\\server.ts < test\\mcp-session.jsonl"',
  '7 个 JSON-RPC 请求全部返回，exit=0，耗时 242ms',
);

const smoke = await create({
  title: 'MCP 通道冒烟：工具能写入问题池',
  kind: 'defect',
  severity: 'major',
  body: '验证 stdio JSON-RPC 到 HTTP 服务的整条链路',
});
if (smoke.code) {
  await close(
    smoke.code,
    'fixed',
    '批量 JSON-RPC 会话验证通过：initialize / tools-list / q_projects / q_brief / q_create / q_gate / q_show 全部正常。',
    'test',
    'test/mcp-out.jsonl',
    '7 条响应，含一次真实写入与门禁查询',
  );
}

// 3. open problems that are genuinely known gaps
await create({
  title: 'blocks 关联缺少循环检测',
  kind: 'defect',
  severity: 'minor',
  body: 'A blocks B 且 B blocks A 时两者都会被判为"被阻塞"，没有任何一方可推进。\n需要在 addLink 时做可达性检查，拒绝成环。',
});

await create({
  title: '受限环境无法使用 node --test 目录模式',
  kind: 'debt',
  severity: 'minor',
  body: 'node --test test/ 会 spawn 子进程，在 DSH 沙箱下报 EPERM。\n目前用 node test/domain.test.ts 直跑（同进程执行）。需要一个不依赖子进程的统一测试入口。',
});

await create({
  title: 'q_brief 用 age 反推创建时间',
  kind: 'debt',
  severity: 'minor',
  body: 'brief 返回 relative age，MCP 渲染时用 nowMinus 反推时间戳，属于近似值。\n应在 brief 里直接返回 created_at，避免二次解析。',
});

await create({
  title: '缺少项目归档/冻结功能',
  kind: 'requirement',
  severity: 'minor',
  body: '项目完成后应能冻结为只读（拒绝新问题与状态变更），并在注册表里标记 archived。目前只有 active。',
});

await create({
  title: 'HTTP 层缺少自动化测试',
  kind: 'debt',
  severity: 'minor',
  body: '领域逻辑有 16 个单测，HTTP/MCP 目前靠 scripts/dev-domain.mjs 与 test/mcp-session.jsonl 手工回归。\n应补 test/http.test.ts：临时库 + 随机端口，覆盖鉴权、错误码、分页。',
});

const brief = await call('GET', '/api/projects/QPOOL/brief');
console.log(`seeded ${created.length} new items; open=${brief.counts.open} total=${brief.counts.total}`);
console.log(`acceptance blocker: ${acceptance.code}; children: ${[mcpChild, consoleChild, disciplineChild].join(', ')}`);
console.log(`gate: ${brief.gate.pass ? 'PASS' : 'FAIL'} — ${brief.gate.reasons.join('; ')}`);
