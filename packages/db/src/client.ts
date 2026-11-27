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
  // An idle connection can fail at any time (a database restart, a pooler closing it). The
  // pool replaces it; without a listener the error would be thrown and crash the process.
  // Only the message is logged: the error object references the client and its password.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(`database: idle connection failed (${error.code ?? 'no code'}): ${error.message}`);
  });
  const db = drizzle({ client: pool, schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>['db'];
/** A database handle or an open transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
