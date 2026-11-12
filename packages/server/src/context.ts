import type { OpenAPIHono } from '@hono/zod-openapi';
import type { SandboxService } from '@sr/core';
import type { Db } from '@sr/db';
import type { Provider } from '@sr/providers';
import type { MiddlewareHandler } from 'hono';

/**
 * - `api_key`: an `sr_...` key, for programmatic use. Can manage sandboxes.
 * - `owner`: the account's owner (the dashboard session in Cloud, the admin token
 *   when self-hosted). Can also manage API keys.
 */
export type AuthKind = 'api_key' | 'owner';

export interface Principal {
  accountId: string;
  kind: AuthKind;
}

/**
 * Checks a bearer token that is not an `sr_` API key. Returns null when the token
 * is not one it recognizes, so the next authenticator can try.
 */
export type Authenticator = (token: string) => Promise<Principal | null>;

export interface ServerDeps {
  db: Db;
  providers: readonly Provider[];
  sandboxes: SandboxService;
  /** Tried in order for tokens that are not `sr_` API keys. */
  authenticators?: readonly Authenticator[];
}

export interface AppEnv {
  Variables: {
    accountId: string;
    authKind: AuthKind;
  };
}

export type App = OpenAPIHono<AppEnv>;
export type Auth = MiddlewareHandler<AppEnv>;
