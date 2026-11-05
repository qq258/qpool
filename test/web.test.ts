// Runs the real console module against a minimal DOM shim, so a broken view
// fails the suite instead of silently rendering a blank page in the browser.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

class FakeNode {
  tagName: string;
  className = '';
  textContent = '';
  innerHTML = '';
  title = '';
  value = '';
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: FakeNode[] = [];
  listeners = new Map<string, Array<(event?: unknown) => void>>();
  removed = false;

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      this.children.push(node instanceof FakeNode ? node : Object.assign(new FakeNode('#text'), { textContent: node }));
    }
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  }

  remove(): void {
    this.removed = true;
  }

  get childElementCount(): number {
    return this.children.length;
  }
}

function textOf(node: FakeNode): string {
  const parts = [node.textContent];
  for (const child of node.children) parts.push(textOf(child));
  return parts.join(' ');
}

interface Harness {
  app: FakeNode;
  navigate: (hash: string) => Promise<void>;
  requests: string[];
}

async function boot(): Promise<Harness> {
  const registry = new Map<string, FakeNode>();
  const app = new FakeNode('main');
  registry.set('app', app);
  registry.set('search-form', new FakeNode('form'));
  registry.set('search-input', new FakeNode('input'));
  registry.set('live', new FakeNode('span'));

  const requests: string[] = [];
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

  const fixtures: Record<string, unknown> = {
    '/api/projects': {
      projects: [
        {
          code: 'DEMO',
          name: 'demo project',
          root_path: 'D:\\demo',
          status: 'active',
          item_count: 3,
          open_count: 1,
          blocker_open: 1,
          waiting_review: 1,
        },
      ],
    },
    '/api/projects/DEMO/brief': {
      project: { code: 'DEMO', name: 'demo project', root: 'D:\\demo', status: 'active' },
      counts: { total: 3, open: 1, closed: 2, blocker_open: 1, waiting_review: 1, blocked: 0, close_rate: 0.667 },
      needs_owner: [
        { code: 'DEMO-2', title: '需要签字的问题', severity: 'blocker', kind: 'defect', age: '2m', created_at: new Date().toISOString(), status: 'waiting_review' },
      ],
      blocker_open: [],
      blocked: [],
      in_progress: [],
      recent: [{ when: '2m', actor: 'agent', action: 'submit', code: 'DEMO-2' }],
      gate: { pass: false, reasons: ['1 item(s) not closed'] },
    },
    '/api/projects/DEMO/tree': {
      project: { code: 'DEMO', name: 'demo project' },
      total: 1,
      roots: [
        {
          id: 1,
          code: 'DEMO-1',
          title: '根问题',
          status: 'open',
          severity: 'major',
          kind: 'defect',
          created_at: new Date().toISOString(),
          childProgress: { closed: 0, total: 0 },
          children: [],
        },
      ],
    },
    '/api/items/DEMO-1': {
      project: { code: 'DEMO', name: 'demo project' },
      item: {
        code: 'DEMO-1',
        title: '详情页问题',
        body: '正文内容',
        kind: 'defect',
        severity: 'major',
        status: 'open',
        version: 2,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        closed_at: null,
        closed_by_type: null,
        close_kind: null,
        close_reason: null,
        signoff_quote: null,
        review_kind: null,
        block_reason: null,
      },
      ancestors: [],
      children: [],
      childProgress: { closed: 0, total: 0 },
      links: { outgoing: [], incoming: [] },
      evidence: [{ kind: 'test', ref: 'node test/run.ts', note: '通过', added_at: new Date().toISOString() }],
      events: [
        { at: new Date().toISOString(), actor: 'agent', action: 'create', payload: '{}', session_id: 'mcp-4321' },
      ],
      blockers: [],
    },
    '/api/search?q=sign': { hits: [] },
    '/api/search?q=detail': {
      hits: [
        {
          code: 'DEMO-1',
          project_code: 'DEMO',
          title: '详情页问题',
          status: 'open',
          severity: 'major',
          kind: 'defect',
          created_at: new Date().toISOString(),
        },
      ],
    },
  };

  globalThis.Node = FakeNode as unknown as typeof Node;
  globalThis.document = {
    getElementById: (id: string) => registry.get(id) ?? null,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode('#text'), { textContent: text }),
    body: new FakeNode('body'),
    activeElement: null,
  } as unknown as Document;

  const windowListeners = new Map<string, Array<() => void>>();
  globalThis.window = {
    addEventListener: (type: string, handler: () => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(handler);
      windowListeners.set(type, list);
    },
    scrollY: 0,
    scrollTo: () => {},
  } as unknown as Window & typeof globalThis;

  Object.defineProperty(globalThis, 'location', {
    value: { hash: '#/projects' },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  });

  globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;

  globalThis.fetch = (async (input: string | URL) => {
    const path = String(input);
    requests.push(path);
    const key = Object.keys(fixtures).find((candidate) => path === candidate || path.startsWith(`${candidate}&`));
    if (!key) return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }), text: async () => '' };
    return json(fixtures[key]);
  }) as unknown as typeof fetch;

  await import('../src/web/app.js');
  await new Promise((resolve) => setTimeout(resolve, 30));

  return {
    app,
    requests,
    async navigate(hash: string) {
      (globalThis.location as unknown as { hash: string }).hash = hash;
      for (const handler of windowListeners.get('hashchange') ?? []) handler();
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  };
}

describe('web console', () => {
  it('renders every view against the real app module', async () => {
    const harness = await boot();

    assert.ok(harness.app.children.length > 0, 'projects view rendered nothing');
    let text = textOf(harness.app);
    assert.match(text, /DEMO/, 'projects view should show the project code');
    assert.match(text, /demo project/);

    await harness.navigate('#/p/DEMO');
    text = textOf(harness.app);
    assert.match(text, /GATE: FAIL/);
    assert.match(text, /需要你签字/);
    assert.match(text, /需要签字的问题/);

    await harness.navigate('#/p/DEMO/tree');
    text = textOf(harness.app);
    assert.match(text, /根问题/, 'tree view should render items');

    await harness.navigate('#/p/DEMO/board');
    text = textOf(harness.app);
    assert.match(text, /未处理/, 'board view should render status columns');

    await harness.navigate('#/item/DEMO-1');
    text = textOf(harness.app);
    assert.match(text, /详情页问题/);
    assert.match(text, /证据（1）/);
    assert.match(text, /审计时间线/);
    assert.match(text, /@4321/, 'timeline should show the session that made the change');

    await harness.navigate('#/search?q=detail');
    text = textOf(harness.app);
    assert.match(text, /1 条结果/);

    assert.ok(
      harness.requests.some((path) => path.startsWith('/api/projects')),
      'the console must talk to the HTTP API',
    );
  });
});
