import { createBoatProvider } from './boat.ts';
import { createDaytonaProvider } from './daytona.ts';
import { createE2BProvider } from './e2b.ts';
import { ModalClient } from 'modal';
import { createModalProvider } from './modal.ts';
import { createNovitaProvider } from './novita.ts';
import { createVercelProvider } from './vercel.ts';
import type { Provider } from './types.ts';

/**
 * Builds the providers whose credentials are present. A provider without an API key
 * is simply not offered.
 *
 * - E2B_API_KEY, E2B_MAX_LIFETIME_HOURS (1 on Hobby, 24 on Pro; defaults to 1)
 * - DAYTONA_API_KEY, DAYTONA_TARGET (optional region, e.g. "us"),
 *   DAYTONA_VM=true to also offer Daytona's Linux VM sandboxes as provider `daytona-vm`
 * - MODAL_TOKEN_ID and MODAL_TOKEN_SECRET offer `modal-gvisor` and `modal-vm` (MODAL_DISABLE_VM=true
 *   for gVisor only); MODAL_ENVIRONMENT, MODAL_APP_NAME, MODAL_IMAGE (optional)
 * - NOVITA_API_KEY, NOVITA_MAX_LIFETIME_HOURS (1 on Free, 3 on Paid, 4 on Enterprise; defaults to 1),
 *   NOVITA_DOMAIN (optional). Build the size templates first: build:novita-templates
 * - BOAT_API_KEY, BOAT_MAX_LIFETIME_HOURS (2 on trial, 720 on paid; defaults to 2), BOAT_BASE_URL (optional)
 * - VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID (all three), VERCEL_MAX_LIFETIME_HOURS
 *   (0.75 on Hobby, 24 on Pro; defaults to 0.75), VERCEL_REGION (optional, e.g. "iad1")
 */
export function providersFromEnv(env: NodeJS.ProcessEnv): Provider[] {
  const providers: Provider[] = [];
  if (env.E2B_API_KEY) {
    const hours = Number(env.E2B_MAX_LIFETIME_HOURS ?? '1');
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('E2B_MAX_LIFETIME_HOURS must be a positive number');
    providers.push(createE2BProvider({ apiKey: env.E2B_API_KEY, maxLifetimeSeconds: Math.floor(hours * 3600) }));
  }
  if (env.DAYTONA_API_KEY) {
    const target = env.DAYTONA_TARGET || undefined;
    providers.push(createDaytonaProvider({ apiKey: env.DAYTONA_API_KEY, target }));
    if (flag(env.DAYTONA_VM)) {
      providers.push(createDaytonaProvider({ apiKey: env.DAYTONA_API_KEY, target, sandboxClass: 'linux-vm' }));
    }
  }
  if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) {
    const environment = env.MODAL_ENVIRONMENT || undefined;
    // Both runtimes share one client (one gRPC connection).
    const client = new ModalClient({ tokenId: env.MODAL_TOKEN_ID, tokenSecret: env.MODAL_TOKEN_SECRET, environment });
    const shared = { client, environment, appName: env.MODAL_APP_NAME || undefined, image: env.MODAL_IMAGE || undefined };
    providers.push(createModalProvider({ ...shared, runtime: 'gvisor' }));
    if (!flag(env.MODAL_DISABLE_VM)) providers.push(createModalProvider({ ...shared, runtime: 'vm' }));
  }
  if (env.NOVITA_API_KEY) {
    providers.push(
      createNovitaProvider({
        apiKey: env.NOVITA_API_KEY,
        maxLifetimeSeconds: hoursToSeconds(env.NOVITA_MAX_LIFETIME_HOURS ?? '1', 'NOVITA_MAX_LIFETIME_HOURS'),
        domain: env.NOVITA_DOMAIN || undefined,
      }),
    );
  }
  if (env.BOAT_API_KEY) {
    providers.push(
      createBoatProvider({
        apiKey: env.BOAT_API_KEY,
        baseUrl: env.BOAT_BASE_URL || undefined,
        maxLifetimeSeconds: hoursToSeconds(env.BOAT_MAX_LIFETIME_HOURS ?? '2', 'BOAT_MAX_LIFETIME_HOURS'),
      }),
    );
  }
  if (env.VERCEL_TOKEN) {
    if (!env.VERCEL_TEAM_ID || !env.VERCEL_PROJECT_ID) throw new Error('VERCEL_TOKEN needs VERCEL_TEAM_ID and VERCEL_PROJECT_ID');
    providers.push(
      createVercelProvider({
        token: env.VERCEL_TOKEN,
        teamId: env.VERCEL_TEAM_ID,
        projectId: env.VERCEL_PROJECT_ID,
        maxLifetimeSeconds: hoursToSeconds(env.VERCEL_MAX_LIFETIME_HOURS ?? '0.75', 'VERCEL_MAX_LIFETIME_HOURS'),
        region: env.VERCEL_REGION || undefined,
      }),
    );
  }
  return providers;
}

function hoursToSeconds(value: string, name: string): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(hours * 3600);
}

function flag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}
