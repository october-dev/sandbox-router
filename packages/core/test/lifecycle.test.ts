// The sandbox lifecycle without billing, as self-hosted deployments run it.
// Cloud billing (holds, charges, races) is tested separately in the cloud repository.
import { createAttempts, sandboxes } from '@sr/db';
import { ProviderError } from '@sr/providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, MAX_RUNNING_PER_ACCOUNT, costMicros, createSandboxService, noBilling } from '../src/index.ts';
import { FakeProvider, closeTestDb, createAccount, resetDb, testDb } from '../../../test/helpers.ts';

const db = testDb();
afterAll(closeTestDb);

let cheap: FakeProvider;
let pricey: FakeProvider;
let service: ReturnType<typeof createSandboxService>;

beforeEach(async () => {
  await resetDb();
  cheap = new FakeProvider('e2b', { cpuRate: 40_000 });
  pricey = new FakeProvider('daytona', { cpuRate: 60_000 });
  service = createSandboxService({ db, billing: noBilling, providers: [pricey, cheap] });
});

const base = { size: 'medium' as const, timeoutSeconds: 600, preset: 'cheap' as const, metadata: {} };

async function expectAppError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('create', () => {
  it('places on the cheapest provider and records the cost of the timeout', async () => {
    const account = await createAccount();
    const sandbox = await service.create(account, base);
    expect(sandbox).toMatchObject({ status: 'running', provider: 'e2b', ratePerHourMicros: 80_000, homeDir: '/home/fake' });
    const window = sandbox.expiresAt.getTime() - sandbox.billingStartedAt!.getTime();
    expect(window).toBeGreaterThanOrEqual(600_000);
    expect(sandbox.holdMicros).toBe(costMicros(80_000, window));
    expect(cheap.sandboxes.size).toBe(1);
  });

  it('places on the fastest provider with the fast preset', async () => {
    const account = await createAccount();
    cheap.createDelayMs = 60;
    await service.create(account, { ...base, provider: 'e2b' });
    await service.create(account, { ...base, provider: 'daytona' });
    expect((await service.create(account, { ...base, preset: 'fast' })).provider).toBe('daytona');
  });

  it('fails over to the next provider and records both attempts', async () => {
    const account = await createAccount();
    cheap.failCreate = new ProviderError('e2b', 'rate_limited', 'too many sandboxes');
    const sandbox = await service.create(account, base);
    expect(sandbox.provider).toBe('daytona');

    const attempts = await db.select().from(createAttempts).orderBy(createAttempts.id);
    expect(attempts.map((a) => [a.provider, a.ok])).toEqual([
      ['e2b', false],
      ['daytona', true],
    ]);
    expect(attempts[0]!.error).toContain('too many sandboxes');
  });

  it('marks the sandbox failed when every provider fails, without leaking provider errors', async () => {
    const account = await createAccount();
    cheap.failCreate = new Error('boom');
    pricey.failCreate = new Error('bang');
    const error = await expectAppError(service.create(account, base), 'no_provider');
    expect(error.message).toContain('e2b failed');
    expect(error.message).toContain('daytona failed');
    expect(error.message).not.toContain('boom');
    const [row] = await db.select().from(sandboxes);
    expect(row).toMatchObject({ status: 'failed', holdMicros: 0, costMicros: 0, endReason: 'create_failed' });
  });

  it('honours a pinned provider and rejects unknown ones', async () => {
    const account = await createAccount();
    const sandbox = await service.create(account, { ...base, provider: 'daytona' });
    expect(sandbox.provider).toBe('daytona');
    expect(sandbox.preset).toBeNull();
    const onlyE2b = createSandboxService({ db, billing: noBilling, providers: [cheap] });
    await expectAppError(onlyE2b.create(account, { ...base, provider: 'daytona' }), 'bad_request');
  });

  it('skips providers whose lifetime cap is too short, and rejects timeouts no provider allows', async () => {
    const account = await createAccount();
    cheap.maxLifetimeSeconds = 3600;
    expect((await service.create(account, { ...base, timeoutSeconds: 7200 })).provider).toBe('daytona');
    pricey.maxLifetimeSeconds = 3600;
    const error = await expectAppError(service.create(account, { ...base, timeoutSeconds: 7200 }), 'bad_request');
    expect(error.message).toContain('3600');
  });

  it('enforces the per-account running limit', async () => {
    const account = await createAccount();
    for (let i = 0; i < MAX_RUNNING_PER_ACCOUNT; i++) await service.create(account, { ...base, size: 'small' });
    await expectAppError(service.create(account, { ...base, size: 'small' }), 'limit_exceeded');
  });
});

describe('kill and settlement', () => {
  it('records the cost of the time used and releases the reservation', async () => {
    const account = await createAccount();
    const sandbox = await service.create(account, base);
    await new Promise((r) => setTimeout(r, 50));
    const ended = await service.kill(account, sandbox.id);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'killed', holdMicros: 0 });
    expect(ended.costMicros).toBe(costMicros(80_000, ended.endedAt!.getTime() - ended.billingStartedAt!.getTime()));
    expect(cheap.killed).toEqual([sandbox.providerSandboxId]);
    expect((await service.kill(account, sandbox.id)).costMicros).toBe(ended.costMicros);
  });

  it('settles expired sandboxes for exactly their timeout window, even when the provider kill fails', async () => {
    const account = await createAccount();
    const sandbox = await service.create(account, base);
    const expiresAt = new Date(Date.now() - 1000);
    await db.update(sandboxes).set({ expiresAt }).where(eq(sandboxes.id, sandbox.id));
    cheap.failKill = new Error('provider down');

    expect(await service.settleExpired()).toBe(1);
    const ended = await service.get(account, sandbox.id);
    expect(ended.endReason).toBe('expired');
    expect(ended.costMicros).toBe(costMicros(80_000, expiresAt.getTime() - sandbox.billingStartedAt!.getTime()));
  });

  it('settles a sandbox the provider lost when an operation finds it gone', async () => {
    const account = await createAccount();
    const sandbox = await service.create(account, base);
    cheap.sandboxes.clear();
    const live = await service.live(account, sandbox.id);
    await expectAppError(live.run(() => live.provider.listFiles(live.ref, '/')), 'sandbox_not_running');
    expect((await service.get(account, sandbox.id)).endReason).toBe('lost');
  });

  it("does not expose another account's sandbox", async () => {
    const owner = await createAccount();
    const other = await createAccount();
    const sandbox = await service.create(owner, base);
    await expectAppError(service.get(other, sandbox.id), 'not_found');
    await expectAppError(service.kill(other, sandbox.id), 'not_found');
  });
});

describe('setTimeout', () => {
  it('extends the deadline on the provider and grows the reservation', async () => {
    const account = await createAccount();
    const sandbox = await service.create(account, base);
    const extended = await service.setTimeout(account, sandbox.id, 1800);
    expect(extended.expiresAt.getTime()).toBeGreaterThan(sandbox.expiresAt.getTime());
    expect(extended.holdMicros).toBeGreaterThan(sandbox.holdMicros);
    expect(cheap.sandboxes.get(sandbox.providerSandboxId!)!.expiresAt).toEqual(extended.expiresAt);
  });

  it("rejects going past the provider's lifetime cap", async () => {
    const account = await createAccount();
    cheap.maxLifetimeSeconds = 900;
    pricey.maxLifetimeSeconds = 900;
    const sandbox = await service.create(account, base);
    await expectAppError(service.setTimeout(account, sandbox.id, 1200), 'bad_request');
  });
});

describe('maintenance', () => {
  it('fails creates that never finished', async () => {
    const account = await createAccount();
    await db.insert(sandboxes).values({
      id: 'sbx_stuck',
      accountId: account,
      status: 'creating',
      size: 'small',
      holdMicros: 500,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 11 * 60_000),
    });
    expect(await service.failStuckCreates()).toBe(1);
    expect(await service.get(account, 'sbx_stuck')).toMatchObject({ status: 'failed', holdMicros: 0 });
  });

  it('kills provider sandboxes we no longer consider running and settles ones the provider lost', async () => {
    const account = await createAccount();
    const orphaned = await service.create(account, base);
    const lost = await service.create(account, base);
    const old = new Date(Date.now() - 5 * 60_000);
    await db.update(sandboxes).set({ createdAt: old, billingStartedAt: old });
    await db.update(sandboxes).set({ status: 'ended', holdMicros: 0 }).where(eq(sandboxes.id, orphaned.id));
    cheap.sandboxes.delete(lost.providerSandboxId!);
    // A sandbox from another deployment must be left alone.
    cheap.sandboxes.set('foreign', { providerSandboxId: 'foreign', sandboxId: 'sbx_unknown', expiresAt: new Date(), files: new Map() });

    expect(await service.reconcile()).toEqual({ killed: 1, lost: 1 });
    expect(cheap.killed).toEqual([orphaned.providerSandboxId]);
    expect(cheap.sandboxes.has('foreign')).toBe(true);
    expect((await service.get(account, lost.id)).endReason).toBe('lost');
  });

  it('does not settle a running sandbox that is only missing from a lagging listing', async () => {
    const account = await createAccount();
    const sandbox = await service.create(account, base);
    const old = new Date(Date.now() - 5 * 60_000);
    await db.update(sandboxes).set({ createdAt: old, billingStartedAt: old });
    cheap.hiddenFromList.add(sandbox.providerSandboxId!);
    expect(await service.reconcile()).toEqual({ killed: 0, lost: 0 });
    expect((await service.get(account, sandbox.id)).status).toBe('running');
  });
});

describe('providers that cannot extend a deadline', () => {
  it('allows shortening but refuses extending, without calling the provider', async () => {
    const account = await createAccount();
    cheap.canExtendTimeout = false;
    pricey.canExtendTimeout = false;
    const sandbox = await service.create(account, { ...base, timeoutSeconds: 1800 });
    const providerDeadline = cheap.sandboxes.get(sandbox.providerSandboxId!)!.expiresAt;

    const shortened = await service.setTimeout(account, sandbox.id, 600);
    expect(shortened.expiresAt.getTime()).toBeLessThan(sandbox.expiresAt.getTime());
    expect(cheap.sandboxes.get(sandbox.providerSandboxId!)!.expiresAt).toEqual(providerDeadline);

    const error = await expectAppError(service.setTimeout(account, sandbox.id, 1200), 'bad_request');
    expect(error.message).toContain("can't be extended");
    expect((await service.get(account, sandbox.id)).expiresAt).toEqual(shortened.expiresAt);
  });
});
