import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export function createDb(connectionString: string, options: { max?: number } = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // Fail instead of waiting forever when every connection is busy.
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
/** A database handle or an open transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
