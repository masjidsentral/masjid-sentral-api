// Error shape (contract §1): { error, code, details? }

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_mismatch'
  | 'validation_failed'
  | 'rate_limited'
  | 'internal'

export type ErrorStatus = 401 | 403 | 404 | 409 | 422 | 429 | 500

export interface ErrorBody {
  error: string
  code: ErrorCode | string
  details?: Record<string, unknown>
}

export function errorBody(error: string, code: ErrorCode | string, details?: Record<string, unknown>): ErrorBody {
  return details ? { error, code, details } : { error, code }
}

/** Throwable error that `app.onError` turns into the contract error shape. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode | string,
    message: string,
    public details?: Record<string, unknown>,
    public headers?: Record<string, string>,
  ) {
    super(message)
  }
}
