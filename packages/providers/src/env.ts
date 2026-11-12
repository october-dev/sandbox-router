import { createDaytonaProvider } from './daytona.ts';
import { createE2BProvider } from './e2b.ts';
import type { Provider } from './types.ts';

/**
 * Builds the providers whose credentials are present. A provider without an API key
 * is simply not offered.
 *
 * - E2B_API_KEY, E2B_MAX_LIFETIME_HOURS (1 on Hobby, 24 on Pro; defaults to 1)
 * - DAYTONA_API_KEY, DAYTONA_TARGET (optional region, e.g. "us")
 */
export function providersFromEnv(env: NodeJS.ProcessEnv): Provider[] {
  const providers: Provider[] = [];
  if (env.E2B_API_KEY) {
    const hours = Number(env.E2B_MAX_LIFETIME_HOURS ?? '1');
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('E2B_MAX_LIFETIME_HOURS must be a positive number');
    providers.push(createE2BProvider({ apiKey: env.E2B_API_KEY, maxLifetimeSeconds: Math.floor(hours * 3600) }));
  }
  if (env.DAYTONA_API_KEY) {
    providers.push(createDaytonaProvider({ apiKey: env.DAYTONA_API_KEY, target: env.DAYTONA_TARGET || undefined }));
  }
  return providers;
}
