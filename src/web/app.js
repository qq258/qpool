const app = document.getElementById('app');

const STATUS_LABEL = {
  open: '未处理',
  triaged: '已归类',
  in_progress: '进行中',
  blocked: '被阻塞',
  waiting_review: '待签字',
  closed: '已闭环',
};
const KIND_LABEL = {
  defect: '缺陷',
  risk: '风险',
  question: '疑问',
  decision: '待决策',
  debt: '技术债',
  requirement: '需求变更',
};
const SEV_LABEL = { blocker: '阻塞', major: '重要', minor: '次要' };
const COLUMNS = ['open', 'triaged', 'in_progress', 'blocked', 'waiting_review', 'closed'];

/* ------------------------------------------------------------------ */
/* tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function badge(kind, label) {
  return h('span', { class: `badge ${kind}`, text: label });
}

function statusDot(status) {
  return h('span', { class: `dot ${status}`, title: STATUS_LABEL[status] ?? status });
}

function ago(iso) {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function fmt(iso) {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      message = payload?.error?.message ?? message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return response.json();
}

function failure(err) {
  app.replaceChildren(
    h('div', { class: 'banner fail' }, h('b', { text: '加载失败' }), h('div', { class: 'dim', text: err.message })),
  );
}

function itemRow(item, extra) {
  return h(
    'a',
    { class: 'row', href: `#/item/${encodeURIComponent(item.code)}` },
    statusDot(item.status),
    h('span', { class: 'code mono', text: item.code }),
    badge(item.severity, SEV_LABEL[item.severity] ?? item.severity),
    h('span', { class: 'title', text: item.title }),
    h('span', { class: 'right' }),
    extra ?? null,
    h('span', { class: 'age', text: ago(item.created_at) }),
  );
}

async function copyPrompt(text) {
  try {
    await navigator.clipboard.writeText(text);
    flash('已复制，粘回 DSH 对话框即可');
  } catch {
    flash('复制失败，请手动选中复制');
  }
}

let flashTimer = null;
function flash(message) {
  let node = document.getElementById('flash');
  if (!node) {
    node = h('div', { id: 'flash', class: 'banner pass' });
    document.body.append(node);
    Object.assign(node.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      margin: '0',
      zIndex: 99,
      maxWidth: '320px',
    });
  }
  node.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => node.remove(), 2400);
}

/* ------------------------------------------------------------------ */
/* router                                                             */
/* ------------------------------------------------------------------ */

let refreshTimer = null;
let silentRender = false;
const lastSignatures = new Map();
const expandedCodes = new Set();
const collapsedCodes = new Set();

function loading() {
  if (silentRender) return;
  app.replaceChildren(h('div', { class: 'loading', text: '加载中…' }));
}

/** True when this view's payload is byte-identical to the previous render. */
function unchanged(key, payload) {
  const signature = JSON.stringify(payload);
  if (lastSignatures.get(key) === signature) return true;
  lastSignatures.set(key, signature);
  return false;
}

function noteUpdated() {
  const el = document.getElementById('updated');
  if (!el) return;
  el.textContent = `更新于 ${new Date().toTimeString().slice(0, 8)}`;
}
function route() {
  const hash = location.hash.replace(/^#/, '') || '/projects';
  const [path, queryString] = hash.split('?');
  const query = new URLSearchParams(queryString ?? '');
  const parts = path.split('/').filter(Boolean);

  clearInterval(refreshTimer);
  refreshTimer = null;

  if (parts[0] === 'projects') return viewProjects();
  if (parts[0] === 'p' && parts[1]) {
    const code = decodeURIComponent(parts[1]);
    if (parts[2] === 'tree') return viewProjectTab(code, 'tree');
    if (parts[2] === 'board') return viewProjectTab(code, 'board');
    return viewProjectTab(code, 'overview');
  }
  if (parts[0] === 'item' && parts[1]) return viewItem(decodeURIComponent(parts[1]));
  if (parts[0] === 'search') return viewSearch(query.get('q') ?? '');
  return viewProjects();
}

function autoRefresh(fn) {
  refreshTimer = setInterval(() => {
    // Never touch a page the user cannot see, or one they are typing in.
    if (document.hidden) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;

    const scrollY = window.scrollY;
    silentRender = true;
    fn()
      .catch(() => {})
      .finally(() => {
        silentRender = false;
        window.scrollTo(0, scrollY);
      });
  }, 10_000);
}

/* ------------------------------------------------------------------ */
/* projects                                                           */
/* ------------------------------------------------------------------ */

async function viewProjects() {
  loading();
  const { projects } = await api('/api/projects');
  if (silentRender && unchanged('projects', projects)) return;
  noteUpdated();
  if (projects.length === 0) {
    app.replaceChildren(
      h('h1', { text: '还没有项目' }),
      h('p', { class: 'dim', text: '在 DSH 里对 DSH 说：“把当前项目注册到 qpool”，或调用 q_projects action=init。' }),
    );
    return;
  }

  const cards = projects.map((project) =>
    h(
      'a',
      { class: 'card click', href: `#/p/${encodeURIComponent(project.code)}` },
      h('div', { class: 'code', text: project.code }),
      h('h3', { text: project.name }),
      h(
        'div',
        { class: 'row', style: 'border:none;background:none;padding:6px 0;margin:0;gap:8px' },
        badge('', `未闭环 ${project.open_count}/${project.item_count}`),
        project.blocker_open ? badge('blocker', `阻塞 ${project.blocker_open}`) : null,
        project.waiting_review ? badge('review', `待签字 ${project.waiting_review}`) : null,
        project.open_count === 0 && project.item_count > 0 ? badge('ok', '已全部闭环') : null,
        project.claimed_other ? badge('review', `被锁定 ${project.claimed_other}`) : null,
        project.status === 'archived' ? badge('closed', '已冻结') : null,
      ),
      h('div', { class: 'path', text: project.root_path }),
    ),
  );

  app.replaceChildren(
    h('h1', { text: '项目' }),
    h('p', { class: 'dim', text: `${projects.length} 个已注册项目 · 点进去看问题树` }),
    h('div', { class: 'grid' }, cards),
  );
  autoRefresh(viewProjects);
}

/* ------------------------------------------------------------------ */
/* project                                                            */
/* ------------------------------------------------------------------ */

async function viewProjectTab(code, tab) {
  loading();
  const [brief, tree] = await Promise.all([
    api(`/api/projects/${encodeURIComponent(code)}/brief`),
    api(`/api/projects/${encodeURIComponent(code)}/tree`),
  ]);
  if (silentRender && unchanged(`p:${code}:${tab}`, [brief, tree])) return;
  noteUpdated();

  const tabs = h(
    'div',
    { class: 'tabs' },
    h('a', { class: tab === 'overview' ? 'on' : '', href: `#/p/${code}`, text: '概览' }),
    h('a', { class: tab === 'tree' ? 'on' : '', href: `#/p/${code}/tree`, text: '问题树' }),
    h('a', { class: tab === 'board' ? 'on' : '', href: `#/p/${code}/board`, text: '看板' }),
  );

  const head = h(
    'div',
    {},
    h('div', { class: 'crumbs' }, h('a', { href: '#/projects', text: '项目' }), ' / ', brief.project.code),
    h('h1', { text: `${brief.project.code} · ${brief.project.name}` }),
    h('div', { class: 'path mono dim', text: brief.project.root }),
    tabs,
  );

  const gateBanner = h(
    'div',
    { class: `banner ${brief.gate.pass ? 'pass' : 'fail'}` },
    h('b', { text: brief.gate.pass ? 'GATE: PASS' : 'GATE: FAIL' }),
    h(
      'div',
      { class: 'dim' },
      brief.gate.pass ? '所有问题已闭环，可以宣布项目完成' : brief.gate.reasons.join('；'),
    ),
  );

  const counts = brief.counts;
  const stats = h(
    'div',
    { class: 'stats' },
    h('div', { class: 'stat' }, h('div', { class: 'n', text: counts.total }), h('div', { class: 'k', text: '问题总数' })),
    h('div', { class: 'stat' }, h('div', { class: 'n', text: counts.open }), h('div', { class: 'k', text: '未闭环' })),
    h(
      'div',
      { class: `stat ${counts.blocker_open ? 'bad' : 'ok'}` },
      h('div', { class: 'n', text: counts.blocker_open }),
      h('div', { class: 'k', text: '未闭环阻塞' }),
    ),
    h(
      'div',
      { class: `stat ${counts.waiting_review ? 'warn' : ''}` },
      h('div', { class: 'n', text: counts.waiting_review }),
      h('div', { class: 'k', text: '等待你签字' }),
    ),
    h(
      'div',
      { class: 'stat ok' },
      h('div', { class: 'n', text: `${Math.round(counts.close_rate * 100)}%` }),
      h('div', { class: 'k', text: '闭环率' }),
    ),
  );

  const body = [];
  if (tab === 'overview') body.push(overviewSections(brief));
  if (tab === 'tree') body.push(treeView(tree.roots));
  if (tab === 'board') body.push(boardView(tree.roots));

  app.replaceChildren(
    head,
    brief.project.status === 'archived'
      ? h('div', { class: 'banner pass' }, h('b', { text: '已冻结' }), h('div', { class: 'dim', text: '项目完成并封存，不再接受任何改动。' }))
      : null,
    gateBanner,
    stats,
    ...body,
  );
  autoRefresh(() => viewProjectTab(code, tab));
}

function overviewSections(brief) {
  const sections = [];

  if (brief.needs_owner.length) {
    sections.push(
      h('h2', { text: `需要你签字（${brief.needs_owner.length}）` }),
      h(
        'div',
        {},
        ...brief.needs_owner.map((item) =>
          itemRow(
            item,
            h('button', {
              class: 'primary',
              text: '复制签字指令',
              onclick: (event) => {
                event.preventDefault();
                event.stopPropagation();
                copyPrompt(
                  `请闭环 ${item.code}（${item.title}）。我确认：问题已解决，同意闭环。`,
                );
              },
            }),
          ),
        ),
      ),
      h('p', {
        class: 'dim',
        text: '点“复制签字指令”→ 在 DSH 对话框粘贴并改成你的原话 → DSH 会用 q_signoff 记录你的原话并闭环。',
      }),
    );
  }

  if (brief.blocker_open.length) {
    sections.push(
      h('h2', { text: `未闭环阻塞（${brief.blocker_open.length}）` }),
      h('div', {}, ...brief.blocker_open.map((item) => itemRow(item))),
    );
  }

  if (brief.blocked.length) {
    sections.push(
      h('h2', { text: `被阻塞（${brief.blocked.length}）` }),
      h(
        'div',
        {},
        ...brief.blocked.map((item) =>
          itemRow(item, h('span', { class: 'badge', text: item.note ?? '等待依赖' })),
        ),
      ),
    );
  }

  if (brief.in_progress.length) {
    sections.push(
      h('h2', { text: `进行中（${brief.in_progress.length}）` }),
      h('div', {}, ...brief.in_progress.map((item) => itemRow(item))),
    );
  }

  if (brief.recent.length) {
    sections.push(
      h('h2', { text: '最近动作' }),
      h(
        'ul',
        { class: 'timeline' },
        ...brief.recent.map((event) =>
          h(
            'li',
            {},
            h('span', { class: 'when', text: event.when }),
            h('span', { class: 'dim', text: event.actor }),
            ' ',
            h('span', { text: event.action }),
            event.code ? ' ' : '',
            event.code ? h('a', { class: 'mono', href: `#/item/${event.code}`, text: event.code }) : '',
          ),
        ),
      ),
    );
  }

  if (brief.claimed && brief.claimed.length) {
    sections.push(
      h('h2', { text: `被对话锁定（${brief.claimed.length}）` }),
      h(
        'div',
        {},
        ...brief.claimed.map((item) =>
          itemRow(item, h('span', { class: 'badge review', text: `@${String(item.holder ?? '').replace(/^mcp-/, '')}` })),
        ),
      ),
    );
  }

  if (!brief.needs_owner.length && !brief.blocker_open.length && !brief.blocked.length && !brief.in_progress.length) {
    sections.push(h('p', { class: 'empty', text: '没有未闭环的问题。' }));
  }

  return h('div', {}, ...sections);
}

function treeView(roots) {
  if (!roots.length) return h('p', { class: 'empty', text: '还没有任何问题。' });

  const renderNode = (node, depth = 0) => {
    const hasChildren = node.children.length > 0;
    const label = h(
      'a',
      { class: 'row', href: `#/item/${node.code}`, style: 'margin:4px 0' },
      statusDot(node.status),
      h('span', { class: 'code mono', text: node.code }),
      badge(node.severity, SEV_LABEL[node.severity] ?? node.severity),
      h('span', { class: 'title', text: node.title }),
      hasChildren
        ? h('span', { class: 'badge', text: `子项 ${node.childProgress.closed}/${node.childProgress.total}` })
        : null,
      h('span', { class: 'right' }),
      h('span', { class: 'age', text: ago(node.created_at) }),
    );

    if (!hasChildren) return h('li', {}, label);

    // Roots start open; deeper nodes start collapsed. Both remember the user's choice.
    const open = depth === 0 ? !collapsedCodes.has(node.code) : expandedCodes.has(node.code);
    return h(
      'li',
      {},
      h(
        'details',
        {
          open: open ? '' : null,
          'data-code': node.code,
          ontoggle: (event) => {
            if (event?.target?.open) {
              expandedCodes.add(node.code);
              collapsedCodes.delete(node.code);
            } else {
              expandedCodes.delete(node.code);
              collapsedCodes.add(node.code);
            }
          },
        },
        h('summary', { style: 'list-style:none' }, label),
        h('ul', { class: 'tree' }, ...node.children.map((child) => renderNode(child, depth + 1))),
      ),
    );
  };

  return h('ul', { class: 'tree', style: 'padding-left:0' }, ...roots.map((node) => renderNode(node, 0)));
}

function boardView(roots) {
  const flat = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(roots);

  const columns = COLUMNS.map((status) => {
    const items = flat.filter((item) => item.status === status);
    return h(
      'div',
      { class: 'column' },
      h('h4', {}, statusDot(status), STATUS_LABEL[status], h('span', { class: 'right dim', text: items.length })),
      ...items.map((item) =>
        h(
          'a',
          { class: 'ticket', href: `#/item/${item.code}` },
          h('div', { class: 'code', text: item.code }),
          h('div', { class: 't', text: item.title }),
          h(
            'div',
            { style: 'display:flex;gap:4px;margin-top:6px' },
            badge(item.severity, SEV_LABEL[item.severity] ?? item.severity),
            badge('', KIND_LABEL[item.kind] ?? item.kind),
          ),
        ),
      ),
    );
  });

  return h('div', { class: 'board' }, ...columns);
}

/* ------------------------------------------------------------------ */
/* item                                                               */
/* ------------------------------------------------------------------ */

async function viewItem(code) {
  loading();
  const detail = await api(`/api/items/${encodeURIComponent(code)}`);
  if (silentRender && unchanged(`item:${code}`, detail)) return;
  noteUpdated();
  const item = detail.item;

  const crumbs = h(
    'div',
    { class: 'crumbs' },
    h('a', { href: '#/projects', text: '项目' }),
    ' / ',
    h('a', { href: `#/p/${detail.project.code}`, text: detail.project.code }),
    ' / ',
    item.code,
  );

  const head = h(
    'div',
    {},
    crumbs,
    h('h1', { text: item.title }),
    h(
      'div',
      { style: 'display:flex;gap:8px;align-items:center;margin:8px 0 14px;flex-wrap:wrap' },
      statusDot(item.status),
      h('span', { class: 'mono', text: item.code }),
      badge(item.severity, SEV_LABEL[item.severity] ?? item.severity),
      badge('', KIND_LABEL[item.kind] ?? item.kind),
      badge(item.status === 'closed' ? 'closed' : item.status === 'waiting_review' ? 'review' : '', STATUS_LABEL[item.status] ?? item.status),
      h('span', { class: 'dim', text: `v${item.version} · 更新于 ${fmt(item.updated_at)}` }),
    ),
  );

  const kv = h(
    'div',
    { class: 'kv' },
    h('span', { class: 'k', text: '创建' }),
    h('span', { class: 'v', text: `${fmt(item.created_at)}（${ago(item.created_at)} 前）` }),
    item.claimed_by
      ? [h('span', { class: 'k', text: '锁定' }), h('span', { class: 'v', text: `@${item.claimed_by}（自 ${fmt(item.claimed_at)}，2 小时未续期自动过期）` })]
      : null,
    detail.ancestors.length
      ? [
          h('span', { class: 'k', text: '上级' }),
          h(
            'span',
            { class: 'v' },
            ...detail.ancestors.map((ancestor) =>
              h('span', {}, h('a', { href: `#/item/${ancestor.code}`, text: `${ancestor.code} ${ancestor.title}` }), ' '),
            ),
          ),
        ]
      : null,
    item.block_reason ? [h('span', { class: 'k', text: '阻塞原因' }), h('span', { class: 'v', text: item.block_reason })] : null,
    item.status === 'closed'
      ? [
          h('span', { class: 'k', text: '闭环' }),
          h(
            'span',
            { class: 'v' },
            `${item.close_kind} · 由 ${item.closed_by_type === 'human' ? 'owner 签字' : 'DSH'} 关闭 · ${fmt(item.closed_at)}`,
          ),
          h('span', { class: 'k', text: '结论' }),
          h('span', { class: 'v', text: item.close_reason ?? '—' }),
          item.signoff_quote
            ? [h('span', { class: 'k', text: '签字原话' }), h('span', { class: 'v', text: `“${item.signoff_quote}”` })]
            : null,
        ]
      : null,
    item.status === 'waiting_review'
      ? [
          h('span', { class: 'k', text: '待验收' }),
          h('span', { class: 'v', text: `拟以 ${item.review_kind ?? 'fixed'} 关闭：${item.close_reason ?? ''}` }),
        ]
      : null,
  );

  const sections = [head, kv];

  if (item.body) sections.push(h('pre', { class: 'body', text: item.body }));

  if (item.status === 'waiting_review') {
    const prompt = `请闭环 ${item.code}（${item.title}）。我确认：问题已解决，同意闭环。`;
    const area = h('textarea', {});
    area.value = prompt;
    sections.push(
      h('h2', { text: '签字' }),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'dim', text: '把下面这段改成你的原话，粘回 DSH 对话框。DSH 会用 q_signoff 记录你的原话完成闭环。' }),
        h(
          'div',
          { class: 'copybox' },
          area,
          h('button', {
            class: 'primary',
            text: '复制',
            onclick: () => copyPrompt(area.value),
          }),
        ),
      ),
    );
  }

  if (detail.children.length) {
    sections.push(
      h('h2', { text: `子问题（${detail.childProgress.closed}/${detail.childProgress.total} 已闭环）` }),
      h('div', {}, ...detail.children.map((child) => itemRow(child))),
    );
  }

  if (detail.blockers.length) {
    sections.push(
      h('h2', { text: '被以下未闭环问题阻塞' }),
      h('div', {}, ...detail.blockers.map((blocker) => itemRow(blocker))),
    );
  }

  if (detail.evidence.length) {
    sections.push(
      h('h2', { text: `证据（${detail.evidence.length}）` }),
      h(
        'ul',
        { class: 'evidence' },
        ...detail.evidence.map((entry) =>
          h(
            'li',
            {},
            h('span', { class: 'badge', text: entry.kind }),
            ' ',
            h('span', { class: 'mono', text: entry.ref || '—' }),
            entry.note ? h('div', { class: 'dim', text: entry.note }) : null,
          ),
        ),
      ),
    );
  } else {
    sections.push(h('h2', { text: '证据' }), h('p', { class: 'empty', text: '还没有证据 —— 闭环前必须至少一条。' }));
  }

  const linkLines = [
    ...detail.links.outgoing.map((link) => `${link.type} → ${link.to_code} ${link.to_title}`),
    ...detail.links.incoming.map((link) => `${link.type} ← ${link.from_code} ${link.from_title}`),
  ];
  if (linkLines.length) {
    sections.push(
      h('h2', { text: '关联' }),
      h('ul', { class: 'evidence' }, ...linkLines.map((line) => h('li', { class: 'dim', text: line }))),
    );
  }

  sections.push(
    h('h2', { text: '审计时间线' }),
    h(
      'ul',
      { class: 'timeline' },
      ...detail.events.map((event) =>
        h(
          'li',
          {},
          h('span', { class: 'when', text: fmt(event.at) }),
          h('span', { class: 'dim', text: event.actor }),
          ' ',
          h('span', { text: event.action }),
          event.session_id ? h('span', { class: 'badge', text: `@${String(event.session_id).replace(/^mcp-/, '')}` }) : null,
          event.payload && event.payload !== '{}' ? h('span', { class: 'dim', text: ` · ${shrink(event.payload)}` }) : null,
        ),
      ),
    ),
  );

  app.replaceChildren(...sections);
  autoRefresh(() => viewItem(code));
}

function shrink(text) {
  const single = String(text).replace(/\s+/g, ' ');
  return single.length > 140 ? `${single.slice(0, 140)}…` : single;
}

/* ------------------------------------------------------------------ */
/* search                                                             */
/* ------------------------------------------------------------------ */

async function viewSearch(q) {
  loading();
  const input = document.getElementById('search-input');
  if (input && input.value !== q) input.value = q;
  if (!q) {
    app.replaceChildren(h('h1', { text: '搜索' }), h('p', { class: 'empty', text: '输入关键词后回车。' }));
    return;
  }
  const { hits } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  app.replaceChildren(
    h('h1', { text: `搜索 “${q}”` }),
    h('p', { class: 'dim', text: `${hits.length} 条结果` }),
    h(
      'div',
      {},
      ...hits.map((item) =>
        itemRow(item, h('span', { class: 'badge', text: item.project_code })),
      ),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

document.getElementById('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = document.getElementById('search-input').value.trim();
  location.hash = value ? `#/search?q=${encodeURIComponent(value)}` : '#/projects';
});

window.addEventListener('hashchange', () => {
  route().catch(failure);
});

document.getElementById('refresh-btn')?.addEventListener('click', () => {
  lastSignatures.clear();
  route().catch(failure);
});

route().catch(failure);
