import { badRequest } from '../../core/errors.ts';
import { buildBrief } from '../../core/brief.ts';
import { exportProject, scheduleExport } from '../../core/export.ts';
import { evaluateGate } from '../../core/gate.ts';
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
  removeLink,
  reopenItem,
  requireItem,
  searchItems,
  showItem,
  signoffItem,
  submitItem,
  updateItem,
} from '../../core/items.ts';
import { requireProject, requireProjectById, resolveProject, touchProject } from '../../core/projects.ts';
import type { ProjectView } from '../../core/projects.ts';
import { headerValue } from '../respond.ts';
import type { RequestContext, Router } from '../router.ts';

function sessionOf(ctx: RequestContext): string | undefined {
  return headerValue(ctx.raw.headers, 'x-qpool-session') ?? undefined;
}

function actorOf(ctx: RequestContext): string {
  return headerValue(ctx.raw.headers, 'x-qpool-actor') ?? 'agent';
}

function projectOf(ctx: RequestContext): ProjectView {
  const fromBody = (ctx.body ?? {}) as { project?: string; root?: string };
  const fromQuery = ctx.query.get('project') ?? undefined;
  const root = ctx.query.get('root') ?? fromBody.root;
  const ref = fromBody.project ?? fromQuery;
  if (!ref && !root) {
    throw badRequest('project (code) or root (path) is required: the service cannot guess from its own cwd');
  }
  return resolveProject(ctx.db, { project: ref, root });
}

function afterMutation(ctx: RequestContext, project: ProjectView): void {
  touchProject(ctx.db, project.id);
  scheduleExport(ctx.db, project, ctx.config.exportDebounceMs);
}

export function registerItemRoutes(router: Router): void {
  /* -------------------------------------------------- list / tree / brief */

  router.get('/api/projects/:code/items', (ctx) => {
    const project = requireProject(ctx.db, ctx.params.code);
    const result = listItems(ctx.db, project, {
      status: queryList(ctx, 'status'),
      kind: queryList(ctx, 'kind'),
      severity: queryList(ctx, 'severity'),
      parent: ctx.query.get('parent') ?? undefined,
      labels: queryList(ctx, 'labels'),
      q: ctx.query.get('q') ?? undefined,
      limit: Number(ctx.query.get('limit') ?? 20),
      cursor: ctx.query.get('cursor') ?? undefined,
      includeClosed: ctx.query.get('includeClosed') === '1' || ctx.query.get('includeClosed') === 'true',
    });
    return { project: { code: project.code, name: project.name }, ...result };
  });

  router.get('/api/projects/:code/tree', (ctx) => {
    const project = requireProject(ctx.db, ctx.params.code);
    return { project: { code: project.code, name: project.name }, ...projectTree(ctx.db, project) };
  });

  router.get('/api/projects/:code/brief', (ctx) => {
    const project = requireProject(ctx.db, ctx.params.code);
    return buildBrief(ctx.db, project);
  });

  router.get('/api/projects/:code/gate', (ctx) => {
    const project = requireProject(ctx.db, ctx.params.code);
    return evaluateGate(ctx.db, project);
  });

  router.post('/api/projects/:code/export', (ctx) => {
    const project = requireProject(ctx.db, ctx.params.code);
    return exportProject(ctx.db, project);
  });

  router.get('/api/search', (ctx) => {
    const q = ctx.query.get('q') ?? '';
    const limit = Number(ctx.query.get('limit') ?? 20);
    return { q, hits: searchItems(ctx.db, q, limit) };
  });

  /* -------------------------------------------------- item detail / create */

  router.get('/api/items/:code', (ctx) => showItem(ctx.db, ctx.params.code));

  router.post('/api/items', (ctx) => {
    const project = projectOf(ctx);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const item = createItem(ctx.db, project, {
      kind: body.kind as string | undefined,
      severity: body.severity as string | undefined,
      title: String(body.title ?? ''),
      body: body.body as string | undefined,
      parent: (body.parent as string | undefined) ?? null,
      labels: Array.isArray(body.labels) ? (body.labels as string[]) : undefined,
      links: Array.isArray(body.links) ? (body.links as Array<{ type: string; to: string }>) : undefined,
      sessionId: sessionOf(ctx),
      actor: actorOf(ctx),
      clientOpId: body.client_op_id as string | undefined,
    });
    afterMutation(ctx, project);
    return { item };
  });

  router.post('/api/items/:code/children', (ctx) => {
    const parent = requireItem(ctx.db, ctx.params.code);
    const project = requireProjectById(ctx.db, parent.project_id);
    const body = (ctx.body ?? {}) as { items?: unknown };
    if (!Array.isArray(body.items)) throw badRequest('items[] is required');
    const result = createChildBatch(ctx.db, project, parent.code, body.items as never[], {
      sessionId: sessionOf(ctx),
      actor: actorOf(ctx),
    });
    afterMutation(ctx, project);
    return result;
  });

  /* -------------------------------------------------- mutations */

  router.patch('/api/items/:code', (ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const item = updateItem(ctx.db, ctx.params.code, {
      version: body.version === undefined ? undefined : Number(body.version),
      title: body.title as string | undefined,
      body: body.body as string | undefined,
      kind: body.kind as string | undefined,
      severity: body.severity as string | undefined,
      labels: Array.isArray(body.labels) ? (body.labels as string[]) : undefined,
      status: body.status as string | undefined,
      parent: body.parent as string | null | undefined,
      blockReason: body.block_reason as string | undefined,
      sessionId: sessionOf(ctx),
      actor: actorOf(ctx),
    });
    scheduleExport(ctx.db, requireProjectById(ctx.db, item.project_id), ctx.config.exportDebounceMs);
    return { item };
  });

  router.post('/api/items/:code/claim', (ctx) => {
    const body = (ctx.body ?? {}) as { force?: boolean; session_id?: string };
    const session = sessionOf(ctx) ?? (typeof body.session_id === 'string' ? body.session_id : '');
    const result = claimItem(ctx.db, ctx.params.code, session, { force: body.force === true });
    scheduleExport(ctx.db, requireProjectById(ctx.db, result.item.project_id), ctx.config.exportDebounceMs);
    return result;
  });

  router.post('/api/items/:code/release', (ctx) => {
    const body = (ctx.body ?? {}) as { force?: boolean; session_id?: string };
    const session = sessionOf(ctx) ?? (typeof body.session_id === 'string' ? body.session_id : '');
    const item = releaseItem(ctx.db, ctx.params.code, session, body.force === true);
    scheduleExport(ctx.db, requireProjectById(ctx.db, item.project_id), ctx.config.exportDebounceMs);
    return { item };
  });

  router.post('/api/items/:code/evidence', (ctx) => {    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const item = attachEvidence(
      ctx.db,
      ctx.params.code,
      { kind: body.kind as string | undefined, ref: body.ref as string | undefined, note: body.note as string | undefined },
      sessionOf(ctx),
    );
    scheduleExport(ctx.db, requireProjectById(ctx.db, item.project_id), ctx.config.exportDebounceMs);
    return { item };
  });

  router.post('/api/items/:code/links', (ctx) => {
    const item = requireItem(ctx.db, ctx.params.code);
    const project = requireProjectById(ctx.db, item.project_id);
    const body = (ctx.body ?? {}) as { type?: string; to?: string };
    if (!body.type || !body.to) throw badRequest('type and to are required');
    const result = addLink(ctx.db, project, item.code, { type: body.type, to: body.to }, sessionOf(ctx));
    afterMutation(ctx, project);
    return result;
  });

  router.delete('/api/items/:code/links/:linkId', (ctx) => {
    const item = requireItem(ctx.db, ctx.params.code);
    const project = requireProjectById(ctx.db, item.project_id);
    const result = removeLink(ctx.db, item.code, Number(ctx.params.linkId));
    afterMutation(ctx, project);
    return result;
  });

  router.post('/api/items/:code/close', (ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const item = closeItem(ctx.db, ctx.params.code, {
      closeKind: body.close_kind as string | undefined,
      reason: body.reason as string | undefined,
      evidence: Array.isArray(body.evidence) ? (body.evidence as never[]) : undefined,
      sessionId: sessionOf(ctx),
      actor: actorOf(ctx),
    });
    scheduleExport(ctx.db, requireProjectById(ctx.db, item.project_id), ctx.config.exportDebounceMs);
    return { item };
  });

  router.post('/api/items/:code/submit', (ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const item = submitItem(ctx.db, ctx.params.code, {
      conclusion: String(body.conclusion ?? ''),
      closeKind: body.close_kind as string | undefined,
      evidence: Array.isArray(body.evidence) ? (body.evidence as never[]) : undefined,
      sessionId: sessionOf(ctx),
      actor: actorOf(ctx),
    });
    scheduleExport(ctx.db, requireProjectById(ctx.db, item.project_id), ctx.config.exportDebounceMs);
    return { item };
  });

  router.post('/api/items/:code/signoff', (ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const item = signoffItem(ctx.db, ctx.params.code, {
      decision: String(body.decision ?? '') as 'approve' | 'accept_risk' | 'reject',
      quote: String(body.quote ?? ''),
      note: body.note as string | undefined,
      sessionId: sessionOf(ctx),
    });
    scheduleExport(ctx.db, requireProjectById(ctx.db, item.project_id), ctx.config.exportDebounceMs);
    return { item };
  });

  router.post('/api/items/:code/reopen', (ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const item = reopenItem(ctx.db, ctx.params.code, String(body.reason ?? ''), sessionOf(ctx));
    scheduleExport(ctx.db, requireProjectById(ctx.db, item.project_id), ctx.config.exportDebounceMs);
    return { item };
  });
}

function queryList(ctx: RequestContext, name: string): string[] | undefined {
  const values = ctx.query.getAll(name).flatMap((value) => value.split(','));
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}
