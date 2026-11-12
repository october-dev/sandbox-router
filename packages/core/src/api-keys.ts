import { apiKeys, type Db } from '@sr/db';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { AppError } from './errors.ts';
import { hashApiKey, newApiKey } from './ids.ts';

const PREFIX_LENGTH = 10;

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Returns the full key exactly once; only its hash is stored. */
export async function createApiKey(db: Db, accountId: string, name: string): Promise<ApiKeySummary & { key: string }> {
  const key = newApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({ accountId, name, prefix: key.slice(0, PREFIX_LENGTH), hash: hashApiKey(key) })
    .returning();
  if (!row) throw new Error('insert returned no row');
  return { key, ...toSummary(row) };
}

export async function listApiKeys(db: Db, accountId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(toSummary);
}

export async function revokeApiKey(db: Db, accountId: string, keyId: string): Promise<void> {
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  if (revoked.length === 0) throw new AppError('not_found', 'API key not found');
}

/** Resolves an API key to its account id, or null if it is unknown or revoked. */
export async function authenticateApiKey(db: Db, key: string): Promise<string | null> {
  const hash = hashApiKey(key);
  const [row] = await db
    .select({ id: apiKeys.id, accountId: apiKeys.accountId })
    .from(apiKeys)
    .where(and(eq(apiKeys.hash, hash), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  // Record usage at most once a minute per key to avoid a write on every request.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, row.id),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - interval '1 minute'`)),
      ),
    );
  return row.accountId;
}

function toSummary(row: typeof apiKeys.$inferSelect): ApiKeySummary {
  return { id: row.id, name: row.name, prefix: row.prefix, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}
