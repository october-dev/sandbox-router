import { AppError } from '@sr/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import type { ErrorJson } from './schemas.ts';

/** The JSON error body for any thrown value. Unexpected errors are logged and hidden. */
export function toErrorBody(error: unknown): ErrorJson & { status: ContentfulStatusCode } {
  if (error instanceof AppError) {
    return { status: error.status as ContentfulStatusCode, error: { code: error.code, message: error.message } };
  }
  if (error instanceof HTTPException) {
    const status = error.status as ContentfulStatusCode;
    return { status, error: { code: status === 413 ? 'payload_too_large' : 'bad_request', message: error.message } };
  }
  if (isLockNotAvailable(error)) {
    return { status: 409, error: { code: 'conflict', message: 'The sandbox is busy with another change; try again' } };
  }
  console.error(error);
  return { status: 500, error: { code: 'internal_error', message: 'Internal server error' } };
}

export function handleError(error: unknown, c: Context) {
  const { status, ...body } = toErrorBody(error);
  return c.json(body, status);
}

/** Postgres lock_not_available (55P03): a lock timeout or NOWAIT, possibly wrapped by the query builder. */
function isLockNotAvailable(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '55P03') return true;
  }
  return false;
}
