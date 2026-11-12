export type AppErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'insufficient_funds'
  | 'limit_exceeded'
  | 'sandbox_not_running'
  | 'file_not_found'
  | 'payload_too_large'
  | 'no_provider'
  | 'provider_error';

const STATUS: Record<AppErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  insufficient_funds: 402,
  limit_exceeded: 429,
  sandbox_not_running: 409,
  file_not_found: 404,
  payload_too_large: 413,
  no_provider: 503,
  provider_error: 502,
};

/** An error with a stable code and HTTP status that is safe to show to API callers. */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;

  constructor(code: AppErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
  }
}
