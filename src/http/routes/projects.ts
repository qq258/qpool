import { badRequest } from '../../core/errors.ts';
import {
  listProjects,
  registerProject,
  requireProject,
  resolveProject,
  setProjectArchived,
} from '../../core/projects.ts';
import { headerValue } from '../respond.ts';
import type { Router } from '../router.ts';

interface RegisterBody {
  path?: string;
  root?: string;
  code?: string;
  name?: string;
  aliases?: string[];
}

export function registerProjectRoutes(router: Router): void {
  router.get('/api/projects', ({ db, raw }) => ({
    projects: listProjects(db, { sessionId: headerValue(raw.headers, 'x-qpool-session') ?? undefined }),
  }));

  router.post('/api/projects', ({ db, body }) => {
    const input = (body ?? {}) as RegisterBody;
    const project = registerProject(db, {
      path: input.path ?? input.root,
      code: input.code,
      name: input.name,
      aliases: Array.isArray(input.aliases) ? input.aliases : undefined,
    });
    return { project };
  });

  router.get('/api/resolve', ({ db, query }) => {
    const project = query.get('project') ?? undefined;
    const root = query.get('root') ?? undefined;
    if (!project && !root) throw badRequest('either project or root is required');
    return { project: resolveProject(db, { project, root }) };
  });

  router.get('/api/projects/:code', ({ db, params }) => ({
    project: requireProject(db, params.code),
  }));

  router.post('/api/projects/:code/archive', (ctx) => {
    const body = (ctx.body ?? {}) as { reason?: string };
    return setProjectArchived(ctx.db, ctx.params.code, true, body.reason);
  });

  router.post('/api/projects/:code/unarchive', (ctx) => {
    const body = (ctx.body ?? {}) as { reason?: string };
    return setProjectArchived(ctx.db, ctx.params.code, false, body.reason);
  });
}
