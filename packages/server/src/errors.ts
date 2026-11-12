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
  console.error(error);
  return { status: 500, error: { code: 'internal_error', message: 'Internal server error' } };
}

export function handleError(error: unknown, c: Context) {
  const { status, ...body } = toErrorBody(error);
  return c.json(body, status);
}
