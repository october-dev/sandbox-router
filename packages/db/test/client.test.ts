import { createDb } from '@sr/db';
import pg from 'pg';
import { expect, test } from 'vitest';

test('a dropped idle connection does not crash the process', async () => {
  const { pool } = createDb(process.env.TEST_DATABASE_URL!, { max: 1 });
  try {
    const { rows } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    // What a database restart or a pooler closing an idle connection looks like.
    await admin.query('select pg_terminate_backend($1)', [rows[0]!.pid]);
    await admin.end();
    // Without an error listener the pool rethrows the idle client's error as an uncaught exception.
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The pool replaces the dead connection.
    const again = await pool.query<{ ok: number }>('select 1 as ok');
    expect(again.rows[0]!.ok).toBe(1);
  } finally {
    await pool.end();
  }
});
