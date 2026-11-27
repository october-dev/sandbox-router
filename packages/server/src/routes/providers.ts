import { createRoute, z } from '@hono/zod-openapi';
import { loadProviderHealth, microsToUsd } from '@sr/core';
import { SIZES } from '@sr/providers';
import type { App, ServerDeps } from '../context.ts';
import { ProviderList } from '../schemas.ts';

/** The unauthenticated provider list reuses recent placement health for this long. */
const HEALTH_CACHE_MS = 5_000;

export function registerProviderRoutes(app: App, deps: ServerDeps) {
  let cached: { at: number; health: Promise<Awaited<ReturnType<typeof loadProviderHealth>>> } | undefined;
  const health = () => {
    if (!cached || Date.now() - cached.at > HEALTH_CACHE_MS) {
      const entry = { at: Date.now(), health: loadProviderHealth(deps.db) };
      // A failed query is not cached.
      entry.health.catch(() => {
        if (cached === entry) cached = undefined;
      });
      cached = entry;
    }
    return cached.health;
  };
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
      const recent = await health();
      return c.json(
        {
          data: deps.providers.map((provider) => {
            const h = recent.get(provider.name);
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
