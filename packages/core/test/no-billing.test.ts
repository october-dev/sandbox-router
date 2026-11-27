import { sandboxes } from '@sr/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, costMicros, createSandboxService, noBilling } from '../src/index.ts';
import { FakeProvider, closeTestDb, createAccount, resetDb, testDb } from '../../../test/helpers.ts';

// Self-hosted mode: the operator pays providers directly, so nothing is refused
// for lack of funds, but every sandbox still records what it cost.

const db = testDb();
afterAll(closeTestDb);

let provider: FakeProvider;

beforeEach(async () => {
  await resetDb();
  provider = new FakeProvider('e2b', { cpuRate: 40_000 });
});

const medium = (timeoutSeconds: number) => ({ size: 'medium' as const, timeoutSeconds, preset: 'cheap' as const, metadata: {} });

describe('noBilling', () => {
  it('creates and extends long-running sandboxes without any balance', async () => {
    const service = createSandboxService({ db, billing: noBilling, providers: [provider] });
    const account = await createAccount();
    const sandbox = await service.create(account, medium(6 * 3600));
    expect(sandbox.status).toBe('running');

    const extended = await service.setTimeout(account, sandbox.id, 12 * 3600);
    expect(extended.expiresAt.getTime()).toBeGreaterThan(sandbox.expiresAt.getTime());
  });

  it('records the reserved and final cost of each sandbox', async () => {
    const service = createSandboxService({ db, billing: noBilling, providers: [provider] });
    const account = await createAccount();
    const sandbox = await service.create(account, medium(600));
    const window = sandbox.expiresAt.getTime() - sandbox.billingStartedAt!.getTime();
    expect(sandbox.holdMicros).toBe(costMicros(sandbox.ratePerHourMicros, window));

    await new Promise((r) => setTimeout(r, 20));
    const ended = await service.kill(account, sandbox.id);
    expect(ended).toMatchObject({ status: 'ended', holdMicros: 0 });
    expect(ended.costMicros).toBeGreaterThan(0);
  });

  it('settles expired sandboxes', async () => {
    const service = createSandboxService({ db, billing: noBilling, providers: [provider] });
    const account = await createAccount();
    const sandbox = await service.create(account, medium(600));
    await db.update(sandboxes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sandboxes.id, sandbox.id));

    expect(await service.settleExpired()).toBe(1);
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, sandbox.id));
    expect(row).toMatchObject({ status: 'ended', endReason: 'expired', holdMicros: 0 });
  });

  it('still enforces the running-sandbox limit, including under concurrency', async () => {
    const service = createSandboxService({ db, billing: noBilling, providers: [provider], maxRunningPerAccount: 2 });
    const account = await createAccount();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => service.create(account, medium(600))));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(AppError);
        expect((r.reason as AppError).code).toBe('limit_exceeded');
      }
    }
  });
});

describe('create and timeout robustness', () => {
  it('fails over from a provider whose create hangs, and records the attempt as failed', async () => {
    const slow = new FakeProvider('e2b', { cpuRate: 10_000 });
    slow.createDelayMs = 1_000;
    const fast = new FakeProvider('daytona', { cpuRate: 90_000 });
    const service = createSandboxService({ db, billing: noBilling, providers: [slow, fast], createAttemptTimeoutMs: 100 });
    const account = await createAccount();
    const sandbox = await service.create(account, medium(600));
    expect(sandbox.provider).toBe('daytona');
    const attempts = await db.execute<{ provider: string; ok: boolean }>(
      sql`select provider, ok from create_attempts where sandbox_id = ${sandbox.id} order by created_at`,
    );
    expect(attempts.rows).toEqual([
      { provider: 'e2b', ok: false },
      { provider: 'daytona', ok: true },
    ]);
  });

  it('refuses a second timeout change while one is in progress instead of queueing it', async () => {
    const service = createSandboxService({ db, billing: noBilling, providers: [provider] });
    const account = await createAccount();
    const sandbox = await service.create(account, medium(600));
    provider.setTimeoutDelayMs = 300;
    const first = service.setTimeout(account, sandbox.id, 1200);
    await new Promise((r) => setTimeout(r, 50));
    const second = await service.setTimeout(account, sandbox.id, 1800).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(AppError);
    expect(second).toMatchObject({ code: 'conflict', status: 409 });
    expect((await first).status).toBe('running');
  });
});

describe('kill and stuck creates', () => {
  it('records a kill that lands during a slow timeout change, billed until the kill', async () => {
    // Short lock waits so the test is quick: an ordinary settle would give up after 100ms.
    const service = createSandboxService({
      db,
      billing: noBilling,
      providers: [provider],
      lockTimeoutMs: 100,
      setTimeoutProviderTimeoutMs: 2_000,
    });
    const account = await createAccount();
    const sandbox = await service.create(account, medium(600));
    provider.setTimeoutDelayMs = 800;
    const extending = service.setTimeout(account, sandbox.id, 1800).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    const killAt = Date.now();
    const ended = await service.kill(account, sandbox.id);
    expect(ended).toMatchObject({ status: 'ended', endReason: 'killed' });
    // Charged until the kill was asked for, not until it was recorded.
    expect(ended.endedAt!.getTime()).toBeLessThan(killAt + 100);
    expect(ended.costMicros).toBe(
      costMicros(ended.ratePerHourMicros, ended.endedAt!.getTime() - ended.billingStartedAt!.getTime()),
    );
    await extending;
    expect((await service.get(account, sandbox.id)).status).toBe('ended');
  });

  it('does not fail a create that may still be failing over across many providers', async () => {
    const many = ['e2b', 'daytona', 'daytona-vm', 'novita', 'modal-gvisor', 'modal-vm'] as const;
    const service = createSandboxService({
      db,
      billing: noBilling,
      providers: many.map((name) => new FakeProvider(name)),
      createAttemptTimeoutMs: 150_000,
    });
    const account = await createAccount();
    const insert = (id: string, minutesAgo: number) =>
      db.insert(sandboxes).values({
        id,
        accountId: account,
        status: 'creating',
        size: 'small',
        holdMicros: 500,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      });
    // Six attempts of up to 2.5 minutes each: a 12-minute-old create may still be running.
    await insert('sbx_failing_over', 12);
    await insert('sbx_really_stuck', 20);
    expect(await service.failStuckCreates()).toBe(1);
    expect((await service.get(account, 'sbx_failing_over')).status).toBe('creating');
    expect((await service.get(account, 'sbx_really_stuck')).status).toBe('failed');
  });
});
