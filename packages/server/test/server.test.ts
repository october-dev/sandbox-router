// The open server as self-hosted deployments run it: an admin token owns one
// account, API keys do the work, and nothing is billed.
import { createSandboxService, noBilling } from '@sr/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { adminTokenAuthenticator } from '../src/auth.ts';
import { FakeProvider, closeTestDb, createAccount, resetDb, testDb } from '../../../test/helpers.ts';

const db = testDb();
afterAll(closeTestDb);

const ADMIN = 'admin-token-'.padEnd(40, 'x');
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDb();
  const owner = await createAccount();
  const providers = [new FakeProvider('e2b')];
  app = createApp({
    db,
    providers,
    sandboxes: createSandboxService({ db, billing: noBilling, providers }),
    authenticators: [adminTokenAuthenticator(ADMIN, owner)],
  });
});

function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return app.request(path, { ...init, headers, body });
}

async function newKey(): Promise<{ id: string; key: string }> {
  const res = await call('/v1/api-keys', { method: 'POST', token: ADMIN, json: { name: 'ci' } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
}

describe('self-hosted authentication', () => {
  it('rejects missing, wrong and almost-right admin tokens', async () => {
    expect((await call('/v1/sandboxes')).status).toBe(401);
    expect((await call('/v1/sandboxes', { token: 'wrong' })).status).toBe(401);
    expect((await call('/v1/sandboxes', { token: ADMIN.slice(0, -1) + 'y' })).status).toBe(401);
  });

  it('lets the admin token manage API keys, but not an API key', async () => {
    const { key } = await newKey();
    expect((await call('/v1/api-keys', { token: key })).status).toBe(403);
    expect((await call('/v1/api-keys', { method: 'POST', token: key, json: { name: 'x' } })).status).toBe(403);
    const listed = (await (await call('/v1/api-keys', { token: ADMIN })).json()) as { data: unknown[] };
    expect(listed.data).toHaveLength(1);
  });

  it('stops accepting a revoked key', async () => {
    const { id, key } = await newKey();
    expect((await call('/v1/sandboxes', { token: key })).status).toBe(200);
    expect((await call(`/v1/api-keys/${id}`, { method: 'DELETE', token: ADMIN })).status).toBe(204);
    expect((await call('/v1/sandboxes', { token: key })).status).toBe(401);
  });
});

describe('self-hosted sandboxes', () => {
  it('runs a sandbox with no balance and reports its cost', async () => {
    const { key } = await newKey();
    const created = await call('/v1/sandboxes', { method: 'POST', token: key, json: { size: 'small', timeout: 3600 } });
    expect(created.status).toBe(201);
    const sandbox = (await created.json()) as { id: string; pricePerHourUsd: number };
    expect(sandbox.pricePerHourUsd).toBeGreaterThan(0);

    const exec = await call(`/v1/sandboxes/${sandbox.id}/exec`, { method: 'POST', token: key, json: { command: 'echo hi' } });
    expect(exec.status).toBe(200);

    const killed = await call(`/v1/sandboxes/${sandbox.id}`, { method: 'DELETE', token: key });
    expect(((await killed.json()) as { status: string }).status).toBe('ended');
  });

  it('serves no billing endpoints', async () => {
    const { key } = await newKey();
    expect((await call('/v1/account', { token: key })).status).toBe(404);
    expect((await call('/v1/ledger', { token: key })).status).toBe(404);
    expect((await call('/webhooks/stripe', { method: 'POST', body: '{}' })).status).toBe(404);

    const doc = (await (await call('/openapi.json')).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain('/v1/sandboxes');
    expect(Object.keys(doc.paths)).not.toContain('/v1/ledger');
  });

  it('lists providers without authentication', async () => {
    const res = await call('/v1/providers');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Array<{ name: string }> }).data[0]!.name).toBe('e2b');
  });
});
