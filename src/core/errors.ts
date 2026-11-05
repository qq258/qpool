export type QpoolErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'FORBIDDEN'
  | 'INTERNAL';

const STATUS: Record<QpoolErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  FORBIDDEN: 403,
  INTERNAL: 500,
};

export class QpoolError extends Error {
  readonly code: QpoolErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: QpoolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'QpoolError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details ?? null } };
  }
}

export const badRequest = (message: string, details?: unknown) => new QpoolError('BAD_REQUEST', message, details);
export const invalid = (message: string, details?: unknown) => new QpoolError('VALIDATION', message, details);
export const notFound = (message: string, details?: unknown) => new QpoolError('NOT_FOUND', message, details);
export const conflict = (message: string, details?: unknown) => new QpoolError('CONFLICT', message, details);
export const invalidState = (message: string, details?: unknown) => new QpoolError('INVALID_STATE', message, details);
export const forbidden = (message: string, details?: unknown) => new QpoolError('FORBIDDEN', message, details);

export function isQpoolError(err: unknown): err is QpoolError {
  return err instanceof QpoolError;
}
