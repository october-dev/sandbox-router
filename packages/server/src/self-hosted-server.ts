import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { MAX_RUNNING_PER_ACCOUNT, createSandboxService, ensureAccount, noBilling } from '@sr/core';
import { createDb, runMigrations } from '@sr/db';
import { type Provider, providersFromEnv } from '@sr/providers';
import { z } from 'zod';
import { createApp } from './app.ts';
import { adminTokenAuthenticator } from './auth.ts';
import type { App } from './context.ts';
import { startWorker } from './worker.ts';

/** The single account a self-hosted deployment runs sandboxes under. */
export const OWNER_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  /** The owner credential. Generate one with `openssl rand -hex 32`. */
  ADMIN_TOKEN: z
    .string()
    .min(32, 'ADMIN_TOKEN must be at least 32 characters; try `openssl rand -hex 32`')
    // Tokens starting with sr_ are checked as API keys, so such an admin token could never sign in.
    .refine((token) => !token.startsWith('sr_'), 'ADMIN_TOKEN must not start with sr_ (that prefix is for API keys)'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  /** Bind address. Defaults to all interfaces, as a container needs. */
  HOST: z.string().min(1).optional(),
  MAX_RUNNING_SANDBOXES: z.coerce.number().int().positive().default(MAX_RUNNING_PER_ACCOUNT),
});

export type SelfHostedEnv = z.infer<typeof Env>;

/** Validates the server settings, treating empty variables (`NAME=` in an env file) as unset. */
export function parseSelfHostedEnv(env: NodeJS.ProcessEnv): SelfHostedEnv {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = Env.safeParse(present);
  if (!parsed.success) throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface SelfHostedServer {
  app: App;
  /** The port the server listens on. */
  port: number;
  providers: readonly Provider[];
  /**
   * Stops accepting connections, lets in-flight requests (including command streams)
   * and running worker tasks finish, then closes the database pool.
   */
  close(): Promise<void>;
}

/**
 * Runs the API and the background worker in one process. Nothing is billed; each
 * sandbox records what it cost. `providers` defaults to the ones configured in `env`.
 */
export async function startSelfHosted(
  env: NodeJS.ProcessEnv,
  options: { providers?: readonly Provider[] } = {},
): Promise<SelfHostedServer> {
  const settings = parseSelfHostedEnv(env);
  const providers = options.providers ?? providersFromEnv(env);
  if (providers.length === 0) {
    throw new Error('Configure at least one provider, e.g. E2B_API_KEY or DAYTONA_API_KEY (see README.md for all of them)');
  }

  await runMigrations(settings.DATABASE_URL);
  const { db, pool } = createDb(settings.DATABASE_URL);
  try {
    await ensureAccount(db, { id: OWNER_ACCOUNT_ID, email: 'owner@self-hosted' });
  } catch (error) {
    await pool.end();
    throw error;
  }

  const sandboxes = createSandboxService({
    db,
    providers,
    billing: noBilling,
    maxRunningPerAccount: settings.MAX_RUNNING_SANDBOXES,
  });
  const app = createApp({
    db,
    providers,
    sandboxes,
    authenticators: [adminTokenAuthenticator(settings.ADMIN_TOKEN, OWNER_ACCOUNT_ID)],
  });

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const listening = serve({ fetch: app.fetch, port: settings.PORT, hostname: settings.HOST }, () => resolve(listening));
    listening.once('error', reject);
  });
  const stopWorker = startWorker(sandboxes);

  let closing: Promise<void> | undefined;
  return {
    app,
    port: (server.address() as AddressInfo).port,
    providers,
    close() {
      closing ??= (async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await stopWorker();
        await pool.end();
      })();
      return closing;
    },
  };
}
