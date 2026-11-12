/**
 * Self-hosted Sandbox Router: the API and the background worker in one process,
 * on your own provider keys. Nothing is billed; each sandbox records what it cost.
 *
 *   DATABASE_URL=postgres://...  ADMIN_TOKEN=<32+ chars>  E2B_API_KEY=...  node src/self-hosted.ts
 *
 * The admin token is the owner credential: use it to create API keys
 * (POST /v1/api-keys), then use those keys for everything else.
 */
import { serve } from '@hono/node-server';
import { MAX_RUNNING_PER_ACCOUNT, createSandboxService, ensureAccount, noBilling } from '@sr/core';
import { createDb, runMigrations } from '@sr/db';
import { providersFromEnv } from '@sr/providers';
import { z } from 'zod';
import { createApp } from './app.ts';
import { adminTokenAuthenticator } from './auth.ts';
import { startWorker } from './worker.ts';

/** The single account a self-hosted deployment runs sandboxes under. */
const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  /** The owner credential. Generate one with `openssl rand -hex 32`. */
  ADMIN_TOKEN: z.string().min(32, 'ADMIN_TOKEN must be at least 32 characters; try `openssl rand -hex 32`'),
  PORT: z.coerce.number().int().positive().default(8787),
  MAX_RUNNING_SANDBOXES: z.coerce.number().int().positive().default(MAX_RUNNING_PER_ACCOUNT),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
const env = parsed.data;

const providers = providersFromEnv(process.env);
if (providers.length === 0) throw new Error('Configure at least one provider (E2B_API_KEY or DAYTONA_API_KEY)');

await runMigrations(env.DATABASE_URL);
const { db, pool } = createDb(env.DATABASE_URL);
await ensureAccount(db, { id: OWNER_ACCOUNT_ID, email: 'owner@self-hosted' });

const sandboxes = createSandboxService({ db, providers, billing: noBilling, maxRunningPerAccount: env.MAX_RUNNING_SANDBOXES });
const app = createApp({
  db,
  providers,
  sandboxes,
  authenticators: [adminTokenAuthenticator(env.ADMIN_TOKEN, OWNER_ACCOUNT_ID)],
});
const stopWorker = startWorker(sandboxes);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`sandbox router listening on :${info.port} with providers: ${providers.map((p) => p.name).join(', ')}`);
});

// Stop accepting connections, let in-flight requests (including command streams)
// and running worker tasks finish, then exit.
process.on('SIGTERM', () => {
  console.log('SIGTERM: draining');
  server.close(() => void stopWorker().then(() => pool.end()).then(() => process.exit(0)));
});
