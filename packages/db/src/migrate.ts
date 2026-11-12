import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.ts';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
// Arbitrary constant identifying the migration lock.
const MIGRATION_LOCK_ID = 727_001;

/**
 * Applies pending migrations. Drizzle's migrator takes no lock, so we hold a
 * session advisory lock on a single connection to keep concurrent deploys from racing.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDb(connectionString, { max: 1 });
  try {
    await pool.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await migrate(db, { migrationsFolder });
    await pool.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url);
  console.log('migrations applied');
}
