import type { ApiClient } from './api.ts';
import { header, displayWidth, itemLine, padCell, sevTag, statusTag, trim } from './render.ts';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: ApiClient, args: Record<string, unknown>) => Promise<string>;
}

/* ------------------------------------------------------------------ */
/* schema helpers                                                      */
/* ------------------------------------------------------------------ */

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string) => ({ type: 'string', description });
const optStr = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const strArray = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少参数 ${name}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalStringArray(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Accepts a project code or a project root path. The path form lets a fresh
 * session find its project from `.qpool/project.json` without knowing the code.
 */
async function resolveProjectArg(client: ApiClient, args: Record<string, unknown>): Promise<string | undefined> {
  const code = optionalString(args, 'project');
  if (code) return code;
  const root = optionalString(args, 'root');
  if (!root) return undefined;
  const payload = await client.get<{ project: { code: string } }>(`/api/resolve?root=${encodeURIComponent(root)}`);
  return payload.project.code;
}

async function requireProjectArg(client: ApiClient, args: Record<string, unknown>): Promise<string> {
  const code = await resolveProjectArg(client, args);
  if (!code) throw new Error('需要 project（项目短码）或 root（项目根目录绝对路径）');
  return code;
}

/* ------------------------------------------------------------------ */
/* tool result shapes (loose on purpose)                               */
/* ------------------------------------------------------------------ */

interface ProjectView {
  code: string;
  name: string;
  root_path: string;
  status: string;
  item_count: number;
  open_count: number;
  blocker_open: number;
  waiting_review: number;
  claimed_total: number;
  claimed_other: number;
  claimed_sessions: number;
  claimed_other_codes: string[];
}

interface BriefPayload {
  project: { code: string; name: string; root: string; status: string };
  counts: Record<string, number>;
  needs_owner: Array<{ code: string; title: string; severity: string; kind: string; age: string; created_at: string; status?: string }>;
  blocker_open: Array<{ code: string; title: string; severity: string; kind: string; age: string; created_at: string; status: string }>;
  blocked: Array<{ code: string; title: string; severity: string; kind: string; age: string; created_at: string; status: string; note?: string | null }>;
  in_progress: Array<{ code: string; title: string; severity: string; kind: string; age: string; created_at: string; status: string }>;
  claimed: Array<{ code: string; title: string; severity: string; kind: string; age: string; created_at: string; status: string; holder: string | null }>;
  recent: Array<{ when: string; actor: string; action: string; code: string | null }>;
  gate: { pass: boolean; reasons: string[] };
}

interface ListPayload {
  items: Array<{
    code: string;
    title: string;
    status: string;
    severity: string;
    kind: string;
    created_at: string;
    block_reason?: string | null;
  }>;
  nextCursor: string | null;
  total: number;
}

interface GatePayload {
  pass: boolean;
  total: number;
  closed: number;
  open: number;
  close_rate: number;
  reasons: string[];
  open_blockers: Array<{ code: string; title: string; severity: string; status: string; age_days?: number }>;
  unsigned_blockers: Array<{ code: string; title: string; severity: string; status: string }>;
  waiting_review: Array<{ code: string; title: string; severity: string; status: string }>;
  accepted_risk: Array<{ code: string; title: string; quote: string | null }>;
}

interface ItemPayload {
  item: {
    code: string;
    title: string;
    body: string;
    kind: string;
    severity: string;
    status: string;
    version: number;
    created_at: string;
    updated_at: string;
    parent_id: number | null;
    block_reason: string | null;
    close_kind: string | null;
    close_reason: string | null;
    signoff_quote: string | null;
    closed_by_type: string | null;
    review_kind: string | null;
    claimed_by: string | null;
    claimed_at: string | null;
  };
  ancestors: Array<{ code: string; title: string }>;
  children: Array<{ code: string; title: string; status: string; severity: string; kind: string; created_at: string }>;
  childProgress: { closed: number; total: number };
  links: {
    outgoing: Array<{ id: number; type: string; to_code: string; to_title: string }>;
    incoming: Array<{ id: number; type: string; from_code: string; from_title: string }>;
  };
  evidence: Array<{ kind: string; ref: string; note: string; added_at: string }>;
  events: Array<{ at: string; actor: string; action: string; payload: string; session_id?: string | null }>;
  blockers: Array<{ code: string; title: string; status: string }>;
}

interface DetailPayload {
  item: ItemPayload['item'];
}

/* ------------------------------------------------------------------ */
/* renderers                                                          */
/* ------------------------------------------------------------------ */

function renderProjects(projects: ProjectView[]): string {
  if (projects.length === 0) {
    return '还没有注册任何项目。用 q_projects action=init 传 path（项目根目录）与可选 code/name 注册。';
  }

  const rows = projects.map((project) => [
    project.code,
    trim(project.name, 22),
    String(project.item_count),
    String(project.open_count),
    project.claimed_other > 0
      ? `${project.claimed_other} 项（${project.claimed_sessions} 个对话）`
      : project.claimed_total > 0
        ? '本对话'
        : '—',
    project.status === 'archived' ? '已冻结' : project.blocker_open > 0 ? '有阻塞' : '进行中',
  ]);
  const headerRow = ['代码', '项目', '问题', '未闭环', '其他对话锁定', '状态'];
  const widths = headerRow.map((title, index) =>
    Math.max(displayWidth(title), ...rows.map((row) => displayWidth(row[index] ?? ''))) + 2,
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => padCell(cell, widths[index] ?? 0))
      .join('')
      .trimEnd();

  const active = projects.filter((project) => project.status !== 'archived').length;
  const locked = projects.reduce((sum, project) => sum + project.claimed_other, 0);

  const out = [
    `qpool 项目（${projects.length} 个：${active} 进行中 / ${projects.length - active} 已冻结）`,
    '',
    line(headerRow),
    line(widths.map((width) => '-'.repeat(Math.max(2, width - 2)))),
    ...rows.map(line),
    '',
    locked > 0
      ? `有 ${locked} 个问题正被其他对话锁定（认领 2 小时未续期会过期）。`
      : '目前没有其他对话锁定任何问题。',
    '细节：q_brief { project: "<代码>" }；被锁的问题可以用 q_show 看是谁、从什么时候开始。',
  ];
  return out.join('\n');
}

function renderBrief(brief: BriefPayload): string {
  const c = brief.counts;
  const gateLine = brief.gate.pass
    ? 'gate: PASS — 所有问题已闭环'
    : `gate: FAIL — ${brief.gate.reasons.join('; ')}`;

  const blocks: string[] = [];
  blocks.push(header(`${brief.project.code} · ${brief.project.name}`));
  if (brief.project.status === 'archived') blocks.push('已冻结（archived）：项目已完成并封存，不再接受任何改动。');
  blocks.push(gateLine);
  blocks.push(
    `total ${c.total} · open ${c.open} · closed ${c.closed} (${Math.round((c.close_rate ?? 0) * 100)}%)` +
      ` · BLOCKER open ${c.blocker_open} · REVIEW ${c.waiting_review} · blocked ${c.blocked}`,
  );

  if (brief.needs_owner.length) {
    blocks.push(
      [
        '',
        `需要 owner 签字 (${brief.needs_owner.length}) — 向 owner 复述问题、拿到原话后调用 q_signoff`,
        ...brief.needs_owner.map((item) => itemLine(item)),
      ].join('\n'),
    );
  }
  if (brief.blocker_open.length) {
    blocks.push(
      ['', `未闭环 BLOCKER (${brief.blocker_open.length})`, ...brief.blocker_open.map((item) => itemLine(item))].join(
        '\n',
      ),
    );
  }
  if (brief.blocked.length) {
    blocks.push(
      [
        '',
        `被阻塞 (${brief.blocked.length})`,
        ...brief.blocked.map((item) => `  ${item.code} [blocked] ${trim(item.title, 90)}${item.note ? ` | ${item.note}` : ''}`),
      ].join('\n'),
    );
  }
  if (brief.in_progress.length) {
    blocks.push(
      ['', `进行中 (${brief.in_progress.length})`, ...brief.in_progress.map((item) => `  ${item.code} ${trim(item.title, 90)}`)].join('\n'),
    );
  }
  if (brief.claimed.length) {
    blocks.push(
      [
        '',
        `被对话锁定 (${brief.claimed.length}) — 开始处理前先 q_claim，避免两个对话改同一条`,
        ...brief.claimed.map((item) => `  ${item.code} @${item.holder ?? '?'} ${trim(item.title, 80)}`),
      ].join('\n'),
    );
  }
  if (brief.recent.length) {
    blocks.push(
      [
        '',
        '最近动作',
        ...brief.recent.map((event) => `  ${event.when} ${event.actor} ${event.action}${event.code ? ` ${event.code}` : ''}`),
      ].join('\n'),
    );
  }
  blocks.push('', `数据源：${brief.project.root}`);
  return blocks.join('\n');
}

function renderList(project: string, payload: ListPayload): string {
  if (payload.items.length === 0) return `${project}: 没有符合条件的问题。`;
  const lines = payload.items.map((item) => itemLine(item));
  const more = payload.nextCursor ? `\n还有更多，使用 cursor=${payload.nextCursor}` : '';
  return `${project}: ${payload.items.length} 条（未闭环总数 ${payload.total}）\n${lines.join('\n')}${more}`;
}

function renderGate(gate: GatePayload, project: string): string {
  const lines: string[] = [];
  lines.push(`GATE ${project}: ${gate.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`total ${gate.total} · closed ${gate.closed} · open ${gate.open} · close_rate ${Math.round(gate.close_rate * 100)}%`);
  if (gate.reasons.length) lines.push(`reasons: ${gate.reasons.join('; ')}`);
  if (gate.open_blockers.length) {
    lines.push('', `open blockers (${gate.open_blockers.length})`);
    for (const item of gate.open_blockers) lines.push(`  ${item.code} [${statusTag(item.status)}] ${trim(item.title, 90)} · ${item.age_days ?? '?'}d`);
  }
  if (gate.unsigned_blockers.length) {
    lines.push('', `closed without human signoff (${gate.unsigned_blockers.length})`);
    for (const item of gate.unsigned_blockers) lines.push(`  ${item.code} ${trim(item.title, 90)}`);
  }
  if (gate.waiting_review.length) {
    lines.push('', `waiting for signoff (${gate.waiting_review.length})`);
    for (const item of gate.waiting_review) lines.push(`  ${item.code} ${trim(item.title, 90)}`);
  }
  if (gate.accepted_risk.length) {
    lines.push('', `risk-accepted (${gate.accepted_risk.length}) — 已计入闭环，但请确认`);
    for (const item of gate.accepted_risk) lines.push(`  ${item.code} ${trim(item.title, 90)} · "${trim(item.quote ?? '', 60)}"`);
  }
  if (gate.pass) lines.push('', '可以宣布项目完成。');
  return lines.join('\n');
}

function renderItem(detail: ItemPayload): string {
  const item = detail.item;
  const lines: string[] = [];
  lines.push(`${item.code} · ${item.title}`);
  lines.push(
    `${statusTag(item.status)} / ${sevTag(item.severity)} / ${item.kind} · version ${item.version} · created ${item.created_at.slice(0, 16).replace('T', ' ')}`,
  );
  if (detail.ancestors.length) lines.push(`上级: ${detail.ancestors.map((a) => `${a.code} ${trim(a.title, 40)}`).join(' > ')}`);
  if (item.claimed_by) lines.push(`锁定: @${item.claimed_by}（自 ${(item.claimed_at ?? '').slice(0, 16).replace('T', ' ')}，2 小时未续期自动过期）`);
  if (item.block_reason) lines.push(`阻塞原因: ${item.block_reason}`);
  if (item.status === 'waiting_review') lines.push(`待签字: 拟以 ${item.review_kind ?? 'fixed'} 关闭 · 结论: ${trim(item.close_reason ?? '', 200)}`);
  if (item.status === 'closed') {
    lines.push(
      `已闭环: ${item.close_kind} by ${item.closed_by_type}${item.signoff_quote ? ` · 原话 "${trim(item.signoff_quote, 100)}"` : ''}`,
    );
    lines.push(`结论: ${trim(item.close_reason ?? '', 300)}`);
  }
  if (item.body) {
    lines.push('');
    const bodyLines = item.body.split(/\r?\n/).map((line) => line.trimEnd());
    for (const line of bodyLines.slice(0, 20)) lines.push(`  ${line}`);
    if (bodyLines.length > 20) lines.push(`  …（正文还有 ${bodyLines.length - 20} 行）`);
  }
  if (detail.children.length) {
    lines.push('', `子问题 (${detail.childProgress.closed}/${detail.childProgress.total} 已闭环)`);
    for (const child of detail.children) lines.push(itemLine({ ...child, created_at: child.created_at }));
  }
  if (detail.blockers.length) {
    lines.push('', '被这些未闭环问题阻塞');
    for (const blocker of detail.blockers) lines.push(`  ${blocker.code} [${blocker.status}] ${trim(blocker.title, 80)}`);
  }
  if (detail.evidence.length) {
    lines.push('', `证据 (${detail.evidence.length})`);
    for (const entry of detail.evidence) {
      lines.push(`  - [${entry.kind}] ${entry.ref}${entry.note ? ` — ${trim(entry.note, 100)}` : ''}`);
    }
  } else {
    lines.push('', '证据: 无（关闭前必须至少一条）');
  }
  const links = [...detail.links.outgoing.map((link) => `${link.type} → ${link.to_code}`), ...detail.links.incoming.map((link) => `${link.type} ← ${link.from_code}`)];
  if (links.length) lines.push('', `关联: ${links.join(' · ')}`);
  if (detail.events.length) {
    lines.push('', '时间线');
    for (const event of detail.events.slice(0, 8)) {
      const session = event.session_id ? ` @${String(event.session_id).replace(/^mcp-/, '')}` : '';
      lines.push(`  ${event.at.slice(0, 16).replace('T', ' ')} ${event.actor}${session} ${event.action}`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* tools                                                              */
/* ------------------------------------------------------------------ */

const PROJECT_ARG = optStr('项目短码，例如 QPOOL。不确定时先调 q_projects。');
const ROOT_ARG = optStr('项目根目录绝对路径；新会话不知道短码时用它，靠 .qpool/project.json 自动识别');
const ITEM_ARG = (description: string) => str(description);

export const TOOLS: ToolDefinition[] = [
  {
    name: 'q_projects',
    description:
      '列出/注册/冻结项目。action=list（默认）看全部项目的未闭环统计；action=init 用项目根目录注册新项目（会写入 .qpool/project.json 并生成短码）；action=resolve 用路径反查项目；action=archive 在 q_gate 通过后冻结项目（之后拒绝一切改动）；action=unarchive 解冻。',
    inputSchema: schema({
      action: { type: 'string', enum: ['list', 'init', 'resolve', 'archive', 'unarchive'], description: '默认 list' },
      path: optStr('注册时的项目根目录（绝对路径），或 resolve 时的路径'),
      project: optStr('archive/unarchive 时的项目短码'),
      code: optStr('可选的项目短码，2-12 位大写字母数字，默认从目录名推导'),
      name: optStr('可读名称'),
      reason: optStr('冻结/解冻原因（会进审计）'),
      aliases: strArray('可选的别名'),
    }),
    async handler(client, args) {
      const action = optionalString(args, 'action') ?? 'list';
      if (action === 'list') {
        const payload = await client.get<{ projects: ProjectView[] }>('/api/projects');
        return renderProjects(payload.projects);
      }
      if (action === 'init') {
        const path = requireString(args, 'path');
        const payload = await client.post<{ project: ProjectView }>('/api/projects', {
          path,
          code: optionalString(args, 'code'),
          name: optionalString(args, 'name'),
          aliases: optionalStringArray(args, 'aliases'),
        });
        return `已注册 ${payload.project.code} · ${payload.project.name}\n路径: ${payload.project.root_path}\n项目内已写入 .qpool/project.json（可随仓库提交，新会话靠它自动识别项目）。`;
      }
      if (action === 'resolve') {
        const root = requireString(args, 'path');
        const payload = await client.get<{ project: ProjectView }>(`/api/resolve?root=${encodeURIComponent(root)}`);
        return `路径 ${root} 属于 ${payload.project.code} · ${payload.project.name}`;
      }
      if (action === 'archive' || action === 'unarchive') {
        const projectCode = requireString(args, 'project');
        const payload = await client.post<{ project: ProjectView; frozen: boolean }>(
          `/api/projects/${encodeURIComponent(projectCode)}/${action}`,
          { reason: optionalString(args, 'reason') },
        );
        return payload.frozen
          ? `${payload.project.code} 已冻结：项目完成并封存，之后的任何写入都会被拒绝。`
          : `${payload.project.code} 已解冻，可以继续记录与修改。`;
      }
      throw new Error(`未知 action: ${action}`);
    },
  },

  {
    name: 'q_brief',
    description:
      '问题池摘要。这是每轮开始的第一手状态：待 owner 签字、未闭环 blocker、被阻塞、进行中、最近动作、项目完成门禁。不传 project 时返回所有项目概览。',
    inputSchema: schema({ project: PROJECT_ARG, root: ROOT_ARG }),
    async handler(client, args) {
      const project = await resolveProjectArg(client, args);
      if (!project) {
        const payload = await client.get<{ projects: ProjectView[] }>('/api/projects');
        return `${renderProjects(payload.projects)}\n\n要看某个项目的细节，调用 q_brief 并传 project。`;
      }
      const brief = await client.get<BriefPayload>(`/api/projects/${encodeURIComponent(project)}/brief`);
      return renderBrief(brief);
    },
  },

  {
    name: 'q_list',
    description:
      '分页列出问题（默认不含已闭环）。支持按状态/类型/严重级/父问题/全文搜索过滤。返回紧凑列表，详情用 q_show。',
    inputSchema: schema({
      project: str('项目短码'),
      root: ROOT_ARG,
      status: optStr('状态过滤，逗号分隔：open,triaged,in_progress,blocked,waiting_review,closed'),
      kind: optStr('类型过滤：defect,risk,question,decision,debt,requirement'),
      severity: optStr('严重级过滤：blocker,major,minor'),
      parent: optStr('只看某个父问题的直接子问题（传问题号）'),
      q: optStr('全文搜索关键词（≥3 字用 FTS 索引，2 字用包含匹配）'),
      limit: num('每页条数，默认 20，上限 50'),
      cursor: optStr('上一页返回的 nextCursor'),
      include_closed: { type: 'boolean', description: '是否包含已闭环（默认 false）' },
    }),
    async handler(client, args) {
      const project = await requireProjectArg(client, args);
      const params = new URLSearchParams();
      for (const name of ['status', 'kind', 'severity', 'parent', 'q', 'cursor'] as const) {
        const value = optionalString(args, name);
        if (value) params.set(name, value);
      }
      const limit = optionalNumber(args, 'limit');
      if (limit) params.set('limit', String(limit));
      if (args.include_closed === true) params.set('includeClosed', '1');
      const payload = await client.get<ListPayload>(`/api/projects/${encodeURIComponent(project)}/items?${params.toString()}`);
      return renderList(project, payload);
    },
  },

  {
    name: 'q_show',
    description: '查看单个问题的完整信息：正文、子问题、依赖、证据、审计时间线、当前 version。改状态前先看 version。',
    inputSchema: schema({ item: ITEM_ARG('问题号，例如 QPOOL-12') }, ['item']),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const detail = await client.get<ItemPayload>(`/api/items/${encodeURIComponent(item)}`);
      return renderItem(detail);
    },
  },

  {
    name: 'q_create',
    description:
      '记录一个新问题。标题写"什么不满足预期"，body 写复现步骤/影响/上下文。只记真正的问题（缺陷、风险、待决策、疑问、技术债、需求变更），不要拿它记实施步骤。返回问题号。',
    inputSchema: schema(
      {
        project: str('项目短码'),
        root: ROOT_ARG,
        title: str('问题标题，3-300 字'),
        kind: { type: 'string', enum: ['defect', 'risk', 'question', 'decision', 'debt', 'requirement'], description: '默认 defect' },
        severity: { type: 'string', enum: ['blocker', 'major', 'minor'], description: '默认 major；blocker 表示不解决则项目不能算完成' },
        body: optStr('详细描述：现象/复现/影响/已排查内容'),
        parent: optStr('父问题号；用于把大问题拆小'),
        labels: strArray('标签'),
        links: {
          type: 'array',
          description: '创建时一并建立的关联',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['blocks', 'relates', 'duplicate_of', 'split_from', 'discovered_from'] },
              to: { type: 'string' },
            },
            required: ['type', 'to'],
          },
        },
        client_op_id: optStr('幂等键：重试时带上同一个值可避免重复创建'),
      },
      ['title'],
    ),
    async handler(client, args) {
      const project = await requireProjectArg(client, args);
      const payload = await client.post<{ item: DetailPayload['item'] }>('/api/items', {
        project,
        title: requireString(args, 'title'),
        kind: optionalString(args, 'kind'),
        severity: optionalString(args, 'severity'),
        body: optionalString(args, 'body'),
        parent: optionalString(args, 'parent'),
        labels: optionalStringArray(args, 'labels'),
        links: Array.isArray(args.links) ? args.links : undefined,
        client_op_id: optionalString(args, 'client_op_id'),
      });
      return `已记录 ${payload.item.code} · ${statusTag(payload.item.status)}/${sevTag(payload.item.severity)} · ${payload.item.title}`;
    },
  },

  {
    name: 'q_create_batch',
    description:
      '把一个大问题拆成一批子问题（一次事务，最多 30 个）。子问题默认继承父问题的项目。拆完父问题仍保留自己的验收结论，但子问题未全闭环时父问题无法关闭。',
    inputSchema: schema(
      {
        parent: str('父问题号'),
        items: {
          type: 'array',
          description: '子问题列表',
          items: {
            type: 'object',
            properties: {
              title: str('子问题标题'),
              kind: optStr('defect/risk/question/decision/debt/requirement'),
              severity: optStr('blocker/major/minor'),
              body: optStr('细节'),
            },
            required: ['title'],
          },
        },
      },
      ['parent', 'items'],
    ),
    async handler(client, args) {
      const parent = requireString(args, 'parent');
      const items = Array.isArray(args.items) ? args.items : [];
      if (items.length === 0) throw new Error('items 不能为空');
      const payload = await client.post<{ created: Array<{ code: string; title: string; severity: string; kind: string }> }>(
        `/api/items/${encodeURIComponent(parent)}/children`,
        { items },
      );
      const lines = payload.created.map((item) => `  ${item.code} [${item.severity}/${item.kind}] ${item.title}`);
      return `${parent} 已拆成 ${payload.created.length} 个子问题：\n${lines.join('\n')}`;
    },
  },

  {
    name: 'q_update',
    description:
      '更新问题字段或状态（带 version 乐观锁：传 q_show 拿到的 version，冲突时会报错并要求重新读取）。允许的状态流转：open→triaged/in_progress/blocked，triaged→in_progress/blocked，in_progress→triaged/blocked，blocked→triaged/in_progress。关闭用 q_submit/q_signoff。',
    inputSchema: schema(
      {
        item: str('问题号'),
        version: num('当前 version（可选但强烈建议，防并发覆盖）'),
        title: optStr('新标题'),
        body: optStr('新正文'),
        kind: optStr('defect/risk/question/decision/debt/requirement'),
        severity: optStr('blocker/major/minor'),
        status: optStr('open/triaged/in_progress/blocked'),
        block_reason: optStr('置为 blocked 时的原因'),
        labels: strArray('替换标签'),
        parent: optStr('改挂到新的父问题（传空字符串可提升为顶层）'),
      },
      ['item'],
    ),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const body: Record<string, unknown> = {};
      for (const key of ['title', 'body', 'kind', 'severity', 'status', 'block_reason', 'labels', 'parent'] as const) {
        if (args[key] !== undefined) body[key] = args[key];
      }
      const version = optionalNumber(args, 'version');
      if (version !== undefined) body.version = version;
      const payload = await client.patch<{ item: DetailPayload['item'] }>(`/api/items/${encodeURIComponent(item)}`, body);
      return `已更新 ${payload.item.code} · ${statusTag(payload.item.status)}/${sevTag(payload.item.severity)} · version ${payload.item.version}`;
    },
  },

  {
    name: 'q_claim',
    description:
      '把问题锁定到当前对话（开始处理前调用），避免两个对话同时改同一条。别的对话正持有时会被拒绝并告知持有者；认领 2 小时未续期会自动过期，可被下一轮对话接管。',
    inputSchema: schema({ item: str('问题号') }, ['item']),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const payload = await client.post<{ item: DetailPayload['item']; taken_over_from: string | null }>(
        `/api/items/${encodeURIComponent(item)}/claim`,
        {},
      );
      return payload.taken_over_from
        ? `${payload.item.code} 已接管（原持有者 @${payload.taken_over_from}，可能已结束会话或认领过期）`
        : `已锁定 ${payload.item.code} 到当前对话（@${payload.item.claimed_by}）`;
    },
  },

  {
    name: 'q_release',
    description: '释放当前对话对问题的锁定（收尾时调用；关闭问题会自动释放）。',
    inputSchema: schema({ item: str('问题号') }, ['item']),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const payload = await client.post<{ item: DetailPayload['item'] }>(
        `/api/items/${encodeURIComponent(item)}/release`,
        {},
      );
      return payload.item.claimed_by
        ? `${payload.item.code} 仍被 @${payload.item.claimed_by} 锁定（不是当前对话）`
        : `已释放 ${payload.item.code} 的锁定`;
    },
  },

  {
    name: 'q_evidence',
    description:
      '给问题追加一条闭环证据。证据类型：commit（提交号）、test（用例/命令与结果）、file（文件:行号）、url、repro（复现步骤）、doc、other。闭环要求至少一条。',
    inputSchema: schema(
      {
        item: str('问题号'),
        kind: { type: 'string', enum: ['commit', 'test', 'file', 'url', 'repro', 'doc', 'other'], description: '默认 other' },
        ref: optStr('证据本身：commit sha / 测试命令 / 文件:行 / URL'),
        note: optStr('补充说明（ref 与 note 至少给一个）'),
      },
      ['item'],
    ),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const payload = await client.post<{ item: DetailPayload['item'] }>(`/api/items/${encodeURIComponent(item)}/evidence`, {
        kind: optionalString(args, 'kind'),
        ref: optionalString(args, 'ref'),
        note: optionalString(args, 'note'),
      });
      return `已给 ${payload.item.code} 记录证据（version ${payload.item.version}）`;
    },
  },

  {
    name: 'q_link',
    description:
      '建立或删除问题关联。type：blocks（前者阻塞后者）、relates（相关）、duplicate_of（前者是后者的重复）、split_from（拆分自）、discovered_from（在做什么时发现的）。',
    inputSchema: schema(
      {
        item: str('问题号'),
        action: { type: 'string', enum: ['add', 'remove'], description: '默认 add' },
        type: optStr('blocks/relates/duplicate_of/split_from/discovered_from'),
        to: optStr('目标问题号（add 时必填）'),
        link_id: num('remove 时的 link id（q_show 可见）'),
      },
      ['item'],
    ),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const action = optionalString(args, 'action') ?? 'add';
      if (action === 'remove') {
        const linkId = optionalNumber(args, 'link_id');
        if (!linkId) throw new Error('remove 需要 link_id');
        await client.delete(`/api/items/${encodeURIComponent(item)}/links/${linkId}`);
        return `已删除 ${item} 的关联 #${linkId}`;
      }
      const type = requireString(args, 'type');
      const to = requireString(args, 'to');
      const payload = await client.post<{ link: { id: number; type: string } }>(`/api/items/${encodeURIComponent(item)}/links`, {
        type,
        to,
      });
      return `已建立关联 ${item} ${type} ${to}（link #${payload.link.id}）`;
    },
  },

  {
    name: 'q_close',
    description:
      '关闭一个非 blocker 问题（DSH 可自行闭环，但必须有结论 + 至少一条证据）。blocker 或打算"接受风险"的问题会被服务端拒绝，必须改走 q_submit → 向 owner 要原话 → q_signoff。',
    inputSchema: schema(
      {
        item: str('问题号'),
        reason: str('闭环结论：改了什么、如何验证、还遗留什么'),
        close_kind: {
          type: 'string',
          enum: ['fixed', 'wontfix', 'not_reproducible', 'duplicate'],
          description: '默认 fixed；duplicate 需要先建立 duplicate_of 关联',
        },
        evidence: {
          type: 'array',
          description: '同时补录的证据',
          items: {
            type: 'object',
            properties: { kind: optStr('commit/test/file/url/repro/doc/other'), ref: optStr('证据'), note: optStr('说明') },
          },
        },
      },
      ['item', 'reason'],
    ),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const payload = await client.post<{ item: DetailPayload['item'] }>(`/api/items/${encodeURIComponent(item)}/close`, {
        reason: requireString(args, 'reason'),
        close_kind: optionalString(args, 'close_kind'),
        evidence: Array.isArray(args.evidence) ? args.evidence : undefined,
      });
      return `已闭环 ${payload.item.code} · ${payload.item.close_kind}（由 DSH 关闭，证据已留档）`;
    },
  },

  {
    name: 'q_submit',
    description:
      '把问题推进到"待验收"（waiting_review），并写入结论 + 证据。blocker 或打算接受风险的问题必须走这条路由，随后由 owner 签字（q_signoff）才算闭环。',
    inputSchema: schema(
      {
        item: str('问题号'),
        conclusion: str('闭环结论：改了什么、如何验证、还有什么遗留'),
        close_kind: { type: 'string', enum: ['fixed', 'accepted_risk', 'duplicate', 'wontfix', 'not_reproducible'], description: '拟关闭方式，默认 fixed' },
        evidence: {
          type: 'array',
          description: '同时补录的证据',
          items: {
            type: 'object',
            properties: { kind: optStr('commit/test/file/url/repro/doc/other'), ref: optStr('证据'), note: optStr('说明') },
          },
        },
      },
      ['item', 'conclusion'],
    ),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const payload = await client.post<{ item: DetailPayload['item'] }>(`/api/items/${encodeURIComponent(item)}/submit`, {
        conclusion: requireString(args, 'conclusion'),
        close_kind: optionalString(args, 'close_kind'),
        evidence: Array.isArray(args.evidence) ? args.evidence : undefined,
      });
      return `${payload.item.code} 已提交验收（拟 ${payload.item.review_kind ?? 'fixed'} 关闭）。\n下一步：把问题与结论复述给 owner，拿到他/她的原话后调用 q_signoff（quote 必须是原话，不能自己编）。`;
    },
  },

  {
    name: 'q_signoff',
    description:
      "记录 owner 的验收签字并闭环。quote 必须是 owner 的真实原话（复述他说的话），严禁自行编造；decision=approve 按拟定方式关闭，accept_risk 记为该风险已被接受，reject 打回 in_progress。",
    inputSchema: schema(
      {
        item: str('问题号'),
        decision: { type: 'string', enum: ['approve', 'accept_risk', 'reject'], description: 'approve / accept_risk / reject' },
        quote: str("owner 的原话，例如「同意闭环，我已确认」"),
        note: optStr('可选备注（打回原因等）'),
      },
      ['item', 'decision', 'quote'],
    ),
    async handler(client, args) {
      const item = requireString(args, 'item');
      const payload = await client.post<{ item: DetailPayload['item'] }>(`/api/items/${encodeURIComponent(item)}/signoff`, {
        decision: requireString(args, 'decision'),
        quote: requireString(args, 'quote'),
        note: optionalString(args, 'note'),
      });
      const result = payload.item.status === 'closed' ? '已闭环' : '已打回 in_progress';
      return `${payload.item.code} ${result} · ${payload.item.close_kind ?? ''} by human`;
    },
  },

  {
    name: 'q_gate',
    description:
      '项目完成门禁：判定是否所有问题都已闭环、所有 blocker 是否都有人类签字。返回 PASS/FAIL 与阻塞清单。只有 PASS 才能宣布项目完成。',
    inputSchema: schema({ project: str('项目短码'), root: ROOT_ARG }),
    async handler(client, args) {
      const project = await requireProjectArg(client, args);
      const gate = await client.get<GatePayload>(`/api/projects/${encodeURIComponent(project)}/gate`);
      return renderGate(gate, project);
    },
  },
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

export function summarizeArgs(args: Record<string, unknown>): string {
  return Object.keys(args)
    .map((key) => `${key}=${String(args[key])}`)
    .join(' ');
}
