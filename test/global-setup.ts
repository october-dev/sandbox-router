import pg from 'pg';
import { runMigrations } from '@sr/db';

/** Recreates the test database and applies migrations once per test run. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sr_test');
  process.env.TEST_DATABASE_URL = url.toString();
  const database = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`drop database if exists "${database}" with (force)`);
  await client.query(`create database "${database}"`);
  await client.end();
  await runMigrations(url.toString());
}
