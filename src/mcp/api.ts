import { baseUrl, loadConfig } from '../core/config.ts';
import type { QpoolConfig } from '../core/config.ts';
import { ensureService } from '../core/service-control.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface ApiOptions {
  sessionId?: string;
}

/**
 * Thin HTTP client. Every MCP process proxies through the single writer so the
 * console and the sessions always observe the same state.
 */
export class ApiClient {
  readonly config: QpoolConfig;
  sessionId?: string;
  /** Who is acting (e.g. agent:codex, agent:dsh-mcp-client); recorded in the audit trail. */
  actor?: string;

  constructor(config: QpoolConfig = loadConfig(), options: ApiOptions = {}) {
    this.config = config;
    this.sessionId = options.sessionId;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await ensureService(this.config);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (method !== 'GET') headers['x-qpool-token'] = this.config.writeToken;
    if (this.sessionId) headers['x-qpool-session'] = this.sessionId;
    if (this.actor) headers['x-qpool-actor'] = this.actor;

    let response: Response;
    try {
      response = await fetch(`${baseUrl(this.config)}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ApiError('UNREACHABLE', `qpool service is not reachable: ${(err as Error).message}`, 0, null);
    }

    const text = await response.text();
    const payload = text ? safeJson(text) : null;
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new ApiError(
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? `HTTP ${response.status}`,
        response.status,
        error?.details ?? null,
      );
    }
    return payload as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
