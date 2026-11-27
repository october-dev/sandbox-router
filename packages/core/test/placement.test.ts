// Placement when a provider gives a sandbox more than its size asks for.
import { sandboxes, type Tx } from '@sr/db';
import type { Size } from '@sr/providers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Billing, createSandboxService } from '../src/index.ts';
import { FakeProvider, closeTestDb, createAccount, resetDb, testDb } from '../../../test/helpers.ts';

const db = testDb();
afterAll(closeTestDb);
beforeEach(resetDb);

/** Reports one more vCPU than the size asks for, like a provider rounding up to its next machine. */
class GenerousProvider extends FakeProvider {
  override async create(input: { size: Size; timeoutSeconds: number; sandboxId: string }) {
    const created = await super.create(input);
    return { ...created, cpu: created.cpu + 1 };
  }
}

/** A fixed budget per account, minus what its live sandboxes hold. */
function budgetBilling(budgetMicros: number): Billing {
  return {
    async availableMicros(tx: Tx, accountId: string) {
      const [held] = await tx
        .select({ total: sql<string>`coalesce(sum(${sandboxes.holdMicros}), 0)` })
        .from(sandboxes)
        .where(and(eq(sandboxes.accountId, accountId), inArray(sandboxes.status, ['creating', 'running'])));
      return budgetMicros - Number(held?.total ?? 0);
    },
    async charge() {},
  };
}

const small = { size: 'small' as const, timeoutSeconds: 3600, preset: 'cheap' as const, metadata: {} };

describe('placement on a larger machine', () => {
  it('raises the hold when the difference is available', async () => {
    const provider = new GenerousProvider('e2b', { cpuRate: 100_000 });
    const service = createSandboxService({ db, providers: [provider], billing: budgetBilling(1_000_000) });
    const account = await createAccount();
    const sandbox = await service.create(account, small);
    expect(sandbox).toMatchObject({ status: 'running', cpu: 2, ratePerHourMicros: 200_000, holdMicros: 200_000 });
  });

  it('refuses the placement and kills the sandbox when the difference is not available', async () => {
    const provider = new GenerousProvider('e2b', { cpuRate: 100_000 });
    // Enough for the 1 vCPU that was asked for, not for the 2 the provider gave.
    const service = createSandboxService({ db, providers: [provider], billing: budgetBilling(150_000) });
    const account = await createAccount();
    const error = await service.create(account, small).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'insufficient_funds' });
    expect(provider.sandboxes.size).toBe(0);
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.accountId, account));
    expect(row).toMatchObject({ status: 'failed', holdMicros: 0, endReason: 'create_failed' });
  });
});
