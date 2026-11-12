import { sandboxes } from '@sr/db';
import { eq } from 'drizzle-orm';
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
