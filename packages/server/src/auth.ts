import { timingSafeEqual } from 'node:crypto';
import { AppError, authenticateApiKey } from '@sr/core';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Authenticator, ServerDeps } from './context.ts';

/**
 * Accepts `Authorization: Bearer <token>`, where the token is an API key (`sr_...`)
 * or anything one of the configured authenticators recognizes.
 */
export function authenticate(deps: Pick<ServerDeps, 'db' | 'authenticators'>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!token) throw new AppError('unauthorized', 'Missing API key. Send it as "Authorization: Bearer sr_..."');

    if (token.startsWith('sr_')) {
      const accountId = await authenticateApiKey(deps.db, token);
      if (!accountId) throw new AppError('unauthorized', 'Invalid or revoked API key');
      c.set('accountId', accountId);
      c.set('authKind', 'api_key');
      return next();
    }
    for (const authenticator of deps.authenticators ?? []) {
      const principal = await authenticator(token);
      if (principal) {
        c.set('accountId', principal.accountId);
        c.set('authKind', principal.kind);
        return next();
      }
    }
    throw new AppError('unauthorized', 'Invalid or expired credentials');
  });
}

/** For account management that API keys may not do, such as managing API keys. */
export const ownerOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('authKind') !== 'owner') {
    throw new AppError('forbidden', 'API keys cannot do this. Use the dashboard, or the admin token when self-hosted.');
  }
  await next();
});

/**
 * Self-hosted: the operator's admin token acts as the owner of one account.
 * Compared in constant time.
 */
export function adminTokenAuthenticator(adminToken: string, accountId: string): Authenticator {
  const expected = Buffer.from(adminToken);
  return async (token) => {
    const given = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return { accountId, kind: 'owner' };
  };
}
