import type { IncomingMessage } from 'node:http';
import type { Db } from '../core/db.ts';
import type { QpoolConfig } from '../core/config.ts';

export type Params = Record<string, string>;

export interface RequestContext {
  db: Db;
  config: QpoolConfig;
  method: string;
  pathname: string;
  query: URLSearchParams;
  params: Params;
  body: unknown;
  raw: IncomingMessage;
}

export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  #routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Params } | null {
    const parts = pathname.split('/').filter(Boolean);
    const upper = method.toUpperCase();

    for (const route of this.#routes) {
      if (route.method !== upper) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Params = {};
      let matched = true;
      for (let index = 0; index < parts.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[index]);
        } else if (segment !== parts[index]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}
