import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  authenticateApiKey,
  createApiKey,
  ensureAccount,
  getAccount,
  listApiKeys,
  rankProviders,
  revokeApiKey,
} from '../src/index.ts';
import { FakeProvider, closeTestDb, createAccount, resetDb, testDb } from '../../../test/helpers.ts';

const db = testDb();
afterAll(closeTestDb);
beforeEach(resetDb);

describe('accounts', () => {
  it('creates an account on first sign-in and updates the email later', async () => {
    const id = '7b0c6f4e-6d0e-4b8e-9d55-2b0a4c3f1a11';
    await ensureAccount(db, { id, email: 'a@example.com' });
    await ensureAccount(db, { id, email: 'b@example.com' });
    expect(await getAccount(db, id)).toMatchObject({ id, email: 'b@example.com' });
  });
});

describe('API keys', () => {
  it('authenticates a new key, lists it without the secret, and stops working once revoked', async () => {
    const account = await createAccount();
    const created = await createApiKey(db, account, 'ci');
    expect(created.key).toMatch(/^sr_[0-9A-Za-z]{32}$/);
    expect(created.prefix).toBe(created.key.slice(0, 10));

    expect(await authenticateApiKey(db, created.key)).toBe(account);
    expect(await authenticateApiKey(db, `${created.key}x`)).toBeNull();

    const listed = await listApiKeys(db, account);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('key');
    expect(listed[0]!.lastUsedAt).not.toBeNull();

    await revokeApiKey(db, account, created.id);
    expect(await authenticateApiKey(db, created.key)).toBeNull();
    expect(await listApiKeys(db, account)).toHaveLength(0);
  });

  it("does not revoke another account's key", async () => {
    const owner = await createAccount();
    const other = await createAccount();
    const created = await createApiKey(db, owner, 'mine');
    await expect(revokeApiKey(db, other, created.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('rankProviders', () => {
  const cheap = new FakeProvider('e2b', { cpuRate: 10 });
  const pricey = new FakeProvider('daytona', { cpuRate: 20 });
  const request = { size: 'small' as const, timeoutSeconds: 300 };
  const health = (entries: Record<string, { medianCreateMs: number | null; failing?: boolean }>) =>
    new Map(Object.entries(entries).map(([k, v]) => [k, { successRate: 1, failing: false, ...v }]));

  it('orders by price for cheap and by latency for fast', () => {
    const stats = health({ e2b: { medianCreateMs: 900 }, daytona: { medianCreateMs: 100 } });
    expect(rankProviders([pricey, cheap], stats, { ...request, preset: 'cheap' }).map((p) => p.name)).toEqual([
      'e2b',
      'daytona',
    ]);
    expect(rankProviders([cheap, pricey], stats, { ...request, preset: 'fast' }).map((p) => p.name)).toEqual([
      'daytona',
      'e2b',
    ]);
  });

  it('puts providers without latency data after measured ones for fast', () => {
    const stats = health({ daytona: { medianCreateMs: 2000 } });
    expect(rankProviders([cheap, pricey], stats, { ...request, preset: 'fast' }).map((p) => p.name)).toEqual([
      'daytona',
      'e2b',
    ]);
  });

  it('moves failing providers to the end', () => {
    const stats = health({ e2b: { medianCreateMs: 100, failing: true }, daytona: { medianCreateMs: 900 } });
    expect(rankProviders([cheap, pricey], stats, { ...request, preset: 'cheap' }).map((p) => p.name)).toEqual([
      'daytona',
      'e2b',
    ]);
  });
});
