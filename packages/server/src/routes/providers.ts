import { createRoute, z } from '@hono/zod-openapi';
import { loadProviderHealth, microsToUsd } from '@sr/core';
import { SIZES } from '@sr/providers';
import type { App, ServerDeps } from '../context.ts';
import { ProviderList } from '../schemas.ts';

export function registerProviderRoutes(app: App, deps: ServerDeps) {
  const json = <T extends z.ZodType>(schema: T, description: string) => ({
    description,
    content: { 'application/json': { schema } },
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/providers',
      tags: ['Account'],
      summary: 'List providers and prices',
      description: 'The providers sandboxes can be placed on, their price for each size, and recent create latency. No authentication needed.',
      responses: { 200: json(ProviderList, 'Providers') },
    }),
    async (c) => {
      const health = await loadProviderHealth(deps.db);
      return c.json(
        {
          data: deps.providers.map((provider) => {
            const h = health.get(provider.name);
            return {
              name: provider.name,
              maxTimeoutSeconds: provider.maxLifetimeSeconds,
              sizes: SIZES.map((size) => {
                const resources = provider.resources(size);
                return { size, ...resources, pricePerHourUsd: microsToUsd(provider.ratePerHourMicros(resources)) };
              }),
              health: {
                medianCreateMs: h?.medianCreateMs ?? null,
                successRate: h?.successRate ?? null,
                failing: h?.failing ?? false,
              },
            };
          }),
        },
        200,
      );
    },
  );
}
