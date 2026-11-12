import { createRoute, z } from '@hono/zod-openapi';
import { createApiKey, listApiKeys, revokeApiKey } from '@sr/core';
import { ownerOnly } from '../auth.ts';
import type { App, Auth, ServerDeps } from '../context.ts';
import { ApiKey, ApiKeyIdParam, CreateApiKeyBody, CreatedApiKey, toApiKey } from '../schemas.ts';
import { ownerErrors, security } from './common.ts';

/** API keys can only be managed by the account owner, never by another API key. */
export function registerApiKeyRoutes(app: App, deps: ServerDeps, auth: Auth) {
  const json = <T extends z.ZodType>(schema: T, description: string) => ({
    description,
    content: { 'application/json': { schema } },
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/api-keys',
      tags: ['Account'],
      summary: 'List API keys',
      security,
      middleware: [auth, ownerOnly],
      responses: { 200: json(z.object({ data: z.array(ApiKey) }), 'Active API keys'), ...ownerErrors },
    }),
    async (c) => c.json({ data: (await listApiKeys(deps.db, c.get('accountId'))).map(toApiKey) }, 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/api-keys',
      tags: ['Account'],
      summary: 'Create an API key',
      security,
      middleware: [auth, ownerOnly],
      request: { body: { content: { 'application/json': { schema: CreateApiKeyBody } }, required: true } },
      responses: { 201: json(CreatedApiKey, 'The new key, shown only once'), ...ownerErrors },
    }),
    async (c) => {
      const created = await createApiKey(deps.db, c.get('accountId'), c.req.valid('json').name);
      return c.json({ ...toApiKey(created), key: created.key }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/api-keys/{id}',
      tags: ['Account'],
      summary: 'Revoke an API key',
      security,
      middleware: [auth, ownerOnly],
      request: { params: ApiKeyIdParam },
      responses: { 204: { description: 'Revoked' }, ...ownerErrors },
    }),
    async (c) => {
      await revokeApiKey(deps.db, c.get('accountId'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}
