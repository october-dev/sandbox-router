import { ErrorBody } from '../schemas.ts';

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorBody } },
});

/** Error responses shared by authenticated routes, for the OpenAPI document. */
export const errors = {
  400: errorResponse('Invalid request'),
  401: errorResponse('Missing or invalid credentials'),
  404: errorResponse('Not found'),
} as const;

export const sandboxErrors = {
  ...errors,
  409: errorResponse('The sandbox is not running'),
  502: errorResponse('The provider failed'),
} as const;

export const createErrors = {
  ...errors,
  402: errorResponse('Not enough available balance'),
  429: errorResponse('Too many running sandboxes'),
  503: errorResponse('No provider could create the sandbox'),
} as const;

export const extendErrors = {
  ...sandboxErrors,
  402: errorResponse('Not enough available balance'),
} as const;

export const ownerErrors = {
  ...errors,
  403: errorResponse('Not available to API keys'),
} as const;

export const security = [{ Bearer: [] }];
