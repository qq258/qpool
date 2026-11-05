import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PACKAGE_ROOT, loadConfig } from '../core/config.ts';
import { ensureService } from '../core/service-control.ts';
import { ApiClient, ApiError } from './api.ts';
import { TOOLS, toolByName } from './tools.ts';

const NAME = 'qpool';
const VERSION = '0.1.0';
const DEFAULT_PROTOCOL = '2025-06-18';

const INSTRUCTIONS = `qpool 是本机跨会话的项目问题池，是项目问题的唯一权威记录（不要另写 markdown TODO）。

工作纪律：
1. 每个会话开始先调 q_brief（不传 project 看全部项目，传 project 看细节）；每完成一轮实质工作后，把新发现的问题与状态变化写回 qpool。
2. 只记录真正的问题：缺陷、风险、待决策、疑问、技术债、需求变更。实施步骤属于任务清单，不进问题池。标题写"什么不满足预期"，body 写现象/复现/影响。
3. 大问题用 q_create_batch 拆成子问题；子问题未全部闭环时父问题无法关闭。
4. 闭环三要素：结论（q_submit 的 conclusion 或 q_close 的 reason）+ 至少一条证据（q_evidence：commit/test/file:line/复现步骤）+ 关闭人。
5. 开始动手处理某个问题前先 q_claim 锁住它；收尾用 q_release（关闭问题会自动释放）。锁 2 小时未续期自动过期，避免别的对话被永久卡住。
6. blocker 与"接受风险"必须 owner 签字：先 q_submit 到 waiting_review，把问题与结论复述给 owner，拿到他/她的原话后用 q_signoff 记录。quote 必须是原话，严禁编造；没有原话就继续等待。
7. 改状态前先 q_show 拿到 version 再 q_update，避免并发覆盖；冲突时重新读取。
8. 只有 q_gate 返回 PASS 时，才能向 owner 报告"项目完成"。`;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const config = loadConfig();
const client = new ApiClient(config, { sessionId: process.env.QPOOL_SESSION });

const CLIENT_LOG = join(PACKAGE_ROOT, 'logs', 'mcp-clients.ndjson');
const CLIENT_LOG_LIMIT = 64 * 1024;

/**
 * Records what the harness says at `initialize`, so audits can attribute a write
 * to a session and to an agent. Every MCP client spawns its own process, so the
 * pid is a usable fallback identity when the client sends no session id.
 */
function noteClientHello(params: Record<string, unknown> | undefined): { sessionId: string; actor: string } {
  const info = (params?.clientInfo ?? {}) as Record<string, unknown>;
  const meta = (params?._meta ?? {}) as Record<string, unknown>;
  const metaKeys = Object.keys(meta);

  let sessionId: string | undefined;
  for (const key of ['sessionId', 'session_id', 'dshSessionId', 'threadId']) {
    if (typeof meta[key] === 'string' && (meta[key] as string).trim()) {
      sessionId = (meta[key] as string).trim();
      break;
    }
  }

  const clientName = typeof info.name === 'string' && info.name.trim() ? info.name.trim() : 'mcp';
  const record = {
    at: new Date().toISOString(),
    pid: process.pid,
    protocolVersion: params?.protocolVersion ?? null,
    client: info,
    metaKeys,
    meta,
    sessionId: sessionId ?? null,
  };
  try {
    mkdirSync(dirname(CLIENT_LOG), { recursive: true });
    if (existsSync(CLIENT_LOG) && statSync(CLIENT_LOG).size > CLIENT_LOG_LIMIT) {
      writeFileSync(CLIENT_LOG, '', 'utf8');
    }
    appendFileSync(CLIENT_LOG, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // attribution must never break the session
  }

  return { sessionId: sessionId ?? `mcp-${process.pid}`, actor: `agent:${clientName}` };
}

function send(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id: JsonRpcRequest['id'], result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function replyError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function textResult(text: string, isError = false): unknown {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

const HINTS: Record<string, string> = {
  INVALID_STATE: '检查状态机与闭环三要素（结论 + 证据 + 关闭人）；blocker 或接受风险必须走 q_submit → owner 签字 → q_signoff。',
  CONFLICT: '该问题已被修改：先 q_show 取最新 version，再重试。',
  VALIDATION: '参数不合法：检查字段名与取值范围（kind/severity/status 见工具说明）。',
  BAD_REQUEST: '请求缺少必要参数，检查工具 schema。',
  NOT_FOUND: '找不到目标：用 q_projects 确认项目短码，q_list 确认问题号。',
  FORBIDDEN: '写入被拒绝：确认 qpool 服务在运行（node src/cli.ts status）。',
  UNREACHABLE: '连不上 qpool 服务：检查 node src/cli.ts status 与 logs/server.log。',
};

function describeFailure(err: unknown): string {
  if (err instanceof ApiError) {
    const hint = HINTS[err.code];
    const details = err.details ? `\n详情: ${JSON.stringify(err.details).slice(0, 600)}` : '';
    return `ERROR [${err.code}] ${err.message}${details}${hint ? `\n建议: ${hint}` : ''}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `ERROR [INTERNAL] ${message}`;
}

async function handleToolCall(id: JsonRpcRequest['id'], params: Record<string, unknown> | undefined): Promise<void> {
  const name = typeof params?.name === 'string' ? params.name : '';
  const tool = toolByName(name);
  if (!tool) {
    replyError(id, -32602, `unknown tool: ${name}`);
    return;
  }
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  try {
    const text = await tool.handler(client, args);
    reply(id, textResult(text));
  } catch (err) {
    process.stderr.write(`[qpool-mcp] ${name} failed: ${describeFailure(err)}\n`);
    reply(id, textResult(describeFailure(err), true));
  }
}

async function dispatch(message: JsonRpcRequest): Promise<void> {
  const method = message.method;
  if (typeof method !== 'string') {
    replyError(message.id, -32600, 'invalid request: method is required');
    return;
  }
  const isNotification = message.id === undefined || message.id === null;

  switch (method) {
    case 'initialize': {
      const requested = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : undefined;
      const hello = noteClientHello(message.params);
      client.sessionId = hello.sessionId;
      client.actor = hello.actor;
      reply(message.id, {
        protocolVersion: requested ?? DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      if (!isNotification) reply(message.id, {});
      return;
    case 'tools/list':
      reply(message.id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    case 'tools/call':
      if (isNotification) return;
      await handleToolCall(message.id, message.params);
      return;
    case 'resources/list':
      reply(message.id, { resources: [] });
      return;
    case 'prompts/list':
      reply(message.id, { prompts: [] });
      return;
    case 'logging/setLevel':
      if (!isNotification) reply(message.id, {});
      return;
    default:
      if (!isNotification) replyError(message.id, -32601, `method not found: ${method}`);
  }
}

let chain: Promise<void> = Promise.resolve();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    replyError(null, -32700, 'parse error');
    return;
  }
  chain = chain
    .then(() => dispatch(parsed))
    .catch((err: unknown) => {
      process.stderr.write(`[qpool-mcp] dispatch failed: ${(err as Error)?.stack ?? String(err)}\n`);
      if (parsed.id !== undefined && parsed.id !== null) replyError(parsed.id, -32603, 'internal error');
    });
});

rl.on('close', () => {
  // stdin closed (batch/one-shot run): finish queued calls, then let the loop drain.
  // Forcing process.exit() here trips a libuv teardown assertion on Windows.
  void chain.finally(() => {
    process.exitCode = 0;
  });
});

// Warm the service in the background so the first real tool call is fast.
void ensureService(config).catch((err: unknown) => {
  process.stderr.write(`[qpool-mcp] service warmup failed: ${(err as Error).message}\n`);
});

process.stderr.write(`[qpool-mcp] ready (service ${config.host}:${config.port})\n`);
