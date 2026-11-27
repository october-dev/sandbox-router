import { posix } from 'node:path';
import {
  accounts,
  createAttempts,
  sandboxes,
  type Db,
  type EndReason,
  type SandboxStatus,
  type Tx,
} from '@sr/db';
import {
  ProviderError,
  type CreatedSandbox,
  type Provider,
  type ProviderErrorCode,
  type ProviderName,
  type SandboxRef,
  type Size,
} from '@sr/providers';
import { and, desc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Billing } from './billing.ts';
import { AppError } from './errors.ts';
import { newSandboxId } from './ids.ts';
import { costMicros } from './money.ts';
import { type Preset, loadProviderHealth, rankProviders } from './router.ts';

export type SandboxRow = typeof sandboxes.$inferSelect;

/** Running sandboxes allowed per account at once. */
export const MAX_RUNNING_PER_ACCOUNT = 10;
export const MIN_TIMEOUT_SECONDS = 60;
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
export const DEFAULT_TIMEOUT_SECONDS = 5 * 60;

export interface CreateSandboxInput {
  size: Size;
  timeoutSeconds: number;
  preset: Preset;
  provider?: ProviderName;
  metadata: Record<string, string>;
}

export interface Deps {
  db: Db;
  providers: readonly Provider[];
  /** `noBilling` for self-hosted deployments, or a prepaid implementation of `Billing`. */
  billing: Billing;
  /** Running sandboxes allowed per account at once. Defaults to MAX_RUNNING_PER_ACCOUNT. */
  maxRunningPerAccount?: number;
  /** Longest one create attempt may take before failing over. Defaults to CREATE_ATTEMPT_TIMEOUT_MS. */
  createAttemptTimeoutMs?: number;
}

/*
 * Locking rules, to keep concurrent API instances and the worker consistent:
 * - When both are needed, lock the sandbox row before the account row.
 * - Funds are checked and holds changed only while the account row is locked.
 * - Never start a second transaction while holding locks in another one.
 * Every transaction that takes row locks sets a lock timeout, so a stuck lock
 * surfaces as an error instead of a hang.
 */
const LOCK_TIMEOUT = sql`set local lock_timeout = '10s'`;

/**
 * Longest the worker waits on one provider call. The worker's tasks never overlap with
 * themselves, so a provider call that hangs would otherwise stop all settling.
 */
export const WORKER_PROVIDER_TIMEOUT_MS = 60_000;
/**
 * Longest one create attempt may take before the next provider is tried. A late success is
 * killed by reconcile(), since the sandbox row no longer points at it.
 */
export const CREATE_ATTEMPT_TIMEOUT_MS = 150_000;
/** Longest a provider may take to move a deadline while the sandbox row is locked. */
export const SET_TIMEOUT_PROVIDER_TIMEOUT_MS = 30_000;
/** Expired sandboxes settled at once; each holds a database connection while its kill runs. */
const SETTLE_CONCURRENCY = 4;
/** Postgres SQLSTATE for a row lock that NOWAIT could not take. */
const LOCK_NOT_AVAILABLE = '55P03';

function withTimeout<T>(promise: Promise<T>, what: string, ms = WORKER_PROVIDER_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const FAILURE_LABELS: Record<ProviderErrorCode, string> = {
  rate_limited: 'at capacity or rate limited',
  unavailable: 'unavailable',
  invalid_request: 'rejected the request',
  sandbox_not_found: 'failed',
  file_not_found: 'failed',
  unknown: 'failed',
};

export function createSandboxService({
  db,
  providers,
  billing,
  maxRunningPerAccount = MAX_RUNNING_PER_ACCOUNT,
  createAttemptTimeoutMs = CREATE_ATTEMPT_TIMEOUT_MS,
}: Deps) {
  const findProvider = (name: string | null): Provider | undefined => providers.find((p) => p.name === name);

  /** Locks the account row, which serializes reservations, and counts its live sandboxes. */
  async function lockAccount(tx: Tx, accountId: string): Promise<{ liveSandboxes: number }> {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).for('update');
    if (!account) throw new AppError('not_found', 'Account not found');
    const [live] = await tx
      .select({ count: sql<string>`count(*)` })
      .from(sandboxes)
      .where(and(eq(sandboxes.accountId, accountId), inArray(sandboxes.status, ['creating', 'running'])));
    return { liveSandboxes: Number(live?.count ?? 0) };
  }

  async function create(accountId: string, input: CreateSandboxInput): Promise<SandboxRow> {
    if (input.provider && !findProvider(input.provider)) {
      throw new AppError('bad_request', `Provider "${input.provider}" is not available`);
    }
    const health = await loadProviderHealth(db);
    const candidates = rankProviders(providers, health, input);
    if (candidates.length === 0) {
      const longest = Math.max(0, ...providers.map((p) => p.maxLifetimeSeconds));
      throw new AppError(
        'bad_request',
        input.provider
          ? `Provider "${input.provider}" allows a timeout of at most ${findProvider(input.provider)!.maxLifetimeSeconds} seconds`
          : `No provider allows a timeout of ${input.timeoutSeconds} seconds; the longest available is ${longest}`,
      );
    }

    // Reserve enough for the priciest candidate, since failover may land on it.
    const estimatedRate = Math.max(...candidates.map((p) => p.ratePerHourMicros(p.resources(input.size))));
    const timeoutMs = input.timeoutSeconds * 1000;
    const sandboxId = newSandboxId();
    await db.transaction(async (tx) => {
      await tx.execute(LOCK_TIMEOUT);
      const { liveSandboxes } = await lockAccount(tx, accountId);
      if (liveSandboxes >= maxRunningPerAccount) {
        throw new AppError('limit_exceeded', `At most ${maxRunningPerAccount} sandboxes can run at once`);
      }
      const hold = costMicros(estimatedRate, timeoutMs);
      const available = await billing.availableMicros(tx, accountId, { lock: true });
      if (available < hold) {
        throw new AppError(
          'insufficient_funds',
          `This sandbox needs $${(hold / 1e6).toFixed(4)} available for its ${input.timeoutSeconds}s timeout; ` +
            `you have $${(available / 1e6).toFixed(4)}`,
        );
      }
      await tx.insert(sandboxes).values({
        id: sandboxId,
        accountId,
        status: 'creating',
        size: input.size,
        preset: input.provider ? null : input.preset,
        holdMicros: hold,
        expiresAt: new Date(Date.now() + timeoutMs),
        metadata: input.metadata,
      });
    });

    const failures: string[] = [];
    for (const provider of candidates) {
      const attemptStart = new Date();
      let created: CreatedSandbox;
      try {
        created = await withTimeout(
          provider.create({ size: input.size, timeoutSeconds: input.timeoutSeconds, sandboxId }),
          `${provider.name} create`,
          createAttemptTimeoutMs,
        );
      } catch (error) {
        console.error(`create ${sandboxId} on ${provider.name} failed:`, error);
        failures.push(`${provider.name} ${error instanceof ProviderError ? FAILURE_LABELS[error.code] : 'failed'}`);
        await recordAttempt(sandboxId, provider.name, input.size, Date.now() - attemptStart.getTime(), errorText(error));
        continue;
      }
      const readyAt = new Date();
      await recordAttempt(sandboxId, provider.name, input.size, readyAt.getTime() - attemptStart.getTime(), null);

      try {
        // Bill from the provider's own start (what it bills us from), bounded by what we observed.
        const startedAt = new Date(
          Math.min(Math.max(created.startedAt?.getTime() ?? attemptStart.getTime(), attemptStart.getTime()), readyAt.getTime()),
        );
        const expiresAt = new Date(startedAt.getTime() + timeoutMs);
        const rate = provider.ratePerHourMicros(created);
        const [placed] = await db
          .update(sandboxes)
          .set({
            status: 'running',
            provider: provider.name,
            providerSandboxId: created.providerSandboxId,
            cpu: created.cpu,
            memoryMib: created.memoryMib,
            diskMib: created.diskMib,
            homeDir: created.homeDir,
            ratePerHourMicros: rate,
            // Exactly the cost of the full timeout. Exceeds the reserved estimate only if
            // the provider reports more resources than the size asks for.
            holdMicros: costMicros(rate, timeoutMs),
            billingStartedAt: startedAt,
            expiresAt,
          })
          .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, 'creating')))
          .returning();
        if (!placed) throw new AppError('provider_error', 'Sandbox creation took too long');
        return placed;
      } catch (error) {
        // Never leave a provider sandbox running that we failed to record, nor a row holding a slot.
        await provider.kill(created.providerSandboxId).catch((e) => console.error(`kill after failed placement:`, e));
        await db
          .update(sandboxes)
          .set({ status: 'failed', holdMicros: 0, endedAt: new Date(), endReason: 'create_failed', costMicros: 0 })
          .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, 'creating')))
          .catch((e: unknown) => console.error(`marking ${sandboxId} failed:`, e));
        throw error;
      }
    }

    await db
      .update(sandboxes)
      .set({ status: 'failed', holdMicros: 0, endedAt: new Date(), endReason: 'create_failed', costMicros: 0 })
      .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.status, 'creating')));
    throw new AppError('no_provider', `No provider could create the sandbox (${failures.join('; ')}). Try again shortly.`);
  }

  /** Placement history feeds routing; losing one record must not fail a create. */
  async function recordAttempt(sandboxId: string, provider: string, size: Size, latencyMs: number, error: string | null) {
    try {
      await db.insert(createAttempts).values({ sandboxId, provider, size, ok: error === null, latencyMs, error });
    } catch (e) {
      console.error('recording a create attempt failed:', e);
    }
  }

  async function get(accountId: string, sandboxId: string): Promise<SandboxRow> {
    const [row] = await db
      .select()
      .from(sandboxes)
      .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.accountId, accountId)));
    if (!row) throw new AppError('not_found', `Sandbox ${sandboxId} not found`);
    return row;
  }

  /** Newest first. `before` is the id of the last sandbox of the previous page. */
  async function list(
    accountId: string,
    options: { status?: SandboxStatus; limit: number; before?: string },
  ): Promise<SandboxRow[]> {
    return db
      .select()
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.accountId, accountId),
          options.status ? eq(sandboxes.status, options.status) : undefined,
          options.before
            ? sql`(${sandboxes.createdAt}, ${sandboxes.id}) < (select created_at, id from sandboxes where id = ${options.before} and account_id = ${accountId})`
            : undefined,
        ),
      )
      .orderBy(desc(sandboxes.createdAt), desc(sandboxes.id))
      .limit(options.limit);
  }

  /** Resolves a sandbox that must be running, with everything needed to operate on it. */
  async function live(accountId: string, sandboxId: string) {
    const row = await get(accountId, sandboxId);
    if (row.status !== 'running' || row.expiresAt.getTime() <= Date.now()) {
      throw new AppError(
        'sandbox_not_running',
        row.status === 'creating' ? `Sandbox ${sandboxId} is still being created` : `Sandbox ${sandboxId} has ended`,
      );
    }
    const provider = findProvider(row.provider);
    if (!provider) throw new AppError('provider_error', `Provider "${row.provider}" is no longer available`);
    const ref: SandboxRef = { providerSandboxId: row.providerSandboxId!, expiresAt: row.expiresAt };
    const homeDir = row.homeDir ?? '/';
    return {
      row,
      provider,
      ref,
      /** Relative paths resolve against the sandbox user's home directory. */
      resolvePath: (path: string) => (path.startsWith('/') ? posix.normalize(path) : posix.join(homeDir, path)),
      /** Maps provider failures to API errors, and settles the sandbox if the provider lost it. */
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        try {
          return await operation();
        } catch (error) {
          throw await translate(row, error);
        }
      },
    };
  }

  /** Must not be called inside a transaction: it may settle the sandbox. */
  async function translate(row: SandboxRow, error: unknown): Promise<unknown> {
    if (!(error instanceof ProviderError)) return error;
    switch (error.code) {
      case 'sandbox_not_found':
        await settle(row.id, new Date(), 'lost');
        return new AppError('sandbox_not_running', `Sandbox ${row.id} is no longer running`, { cause: error });
      case 'file_not_found':
        return new AppError('file_not_found', 'No such file or directory', { cause: error });
      case 'invalid_request':
        return new AppError('bad_request', error.message, { cause: error });
      default:
        return new AppError('provider_error', error.message, { cause: error });
    }
  }

  async function kill(accountId: string, sandboxId: string): Promise<SandboxRow> {
    const row = await get(accountId, sandboxId);
    if (row.status === 'creating') {
      throw new AppError('sandbox_not_running', `Sandbox ${sandboxId} is still being created`);
    }
    if (row.status !== 'running') return row;
    const provider = findProvider(row.provider);
    if (provider) {
      try {
        await provider.kill(row.providerSandboxId!);
      } catch (error) {
        throw await translate(row, error);
      }
    } else {
      console.warn(`provider ${row.provider} is not configured; ending ${row.id} without killing it there`);
    }
    await settle(row.id, new Date(), 'killed');
    return get(accountId, sandboxId);
  }

  /** Sets the sandbox to expire `timeoutSeconds` from now, adjusting the reserved funds. */
  async function setTimeout(accountId: string, sandboxId: string, timeoutSeconds: number): Promise<SandboxRow> {
    const { row, provider } = await live(accountId, sandboxId);
    const expiresAt = new Date(Date.now() + timeoutSeconds * 1000);
    const latest = row.billingStartedAt!.getTime() + provider.maxLifetimeSeconds * 1000;
    if (expiresAt.getTime() > latest) {
      const maxNow = Math.floor((latest - Date.now()) / 1000);
      throw new AppError(
        'bad_request',
        `Sandboxes on ${provider.name} live at most ${provider.maxLifetimeSeconds}s; this one can be extended by up to ${Math.max(0, maxNow)}s from now`,
      );
    }
    const insufficient = (increase: number, available: number) =>
      new AppError(
        'insufficient_funds',
        `Extending needs $${(increase / 1e6).toFixed(4)} more available; you have $${(available / 1e6).toFixed(4)}`,
      );

    let providerFailure: { error: unknown } | null = null;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(LOCK_TIMEOUT);
        // The sandbox lock serializes timeout changes on one sandbox, including the provider
        // call, so the provider and our row always agree on the deadline. A second change while
        // one is in progress is refused rather than queued, so concurrent requests can't tie up
        // database connections waiting on the provider.
        const [current] = await tx
          .select()
          .from(sandboxes)
          .where(eq(sandboxes.id, sandboxId))
          .for('update', { noWait: true })
          .catch((error: unknown) => {
            if (isLockNotAvailable(error)) {
              throw new AppError('conflict', `The timeout of sandbox ${sandboxId} is already being changed; try again`);
            }
            throw error;
          });
        if (!current || current.status !== 'running' || current.expiresAt.getTime() <= Date.now()) {
          throw new AppError('sandbox_not_running', `Sandbox ${sandboxId} has ended`);
        }
        if (!provider.canExtendTimeout && expiresAt.getTime() > current.expiresAt.getTime()) {
          throw new AppError(
            'bad_request',
            `Sandboxes on ${provider.name} can't be extended after creation; this one can be shortened, or run until ${current.expiresAt.toISOString()}. Create it with a longer timeout instead.`,
          );
        }
        const hold = costMicros(current.ratePerHourMicros, expiresAt.getTime() - current.billingStartedAt!.getTime());
        const increase = hold - current.holdMicros;
        if (increase > 0) {
          const available = await billing.availableMicros(tx, accountId, { lock: false });
          if (available < increase) throw insufficient(increase, available);
        }
        // A provider that can't move its deadline keeps the original one; the worker kills the
        // sandbox at our (earlier) deadline instead.
        if (provider.canExtendTimeout) {
          try {
            await withTimeout(
              provider.setTimeout({ providerSandboxId: current.providerSandboxId!, expiresAt }),
              `${provider.name} set timeout`,
              SET_TIMEOUT_PROVIDER_TIMEOUT_MS,
            );
          } catch (error) {
            providerFailure = { error };
            throw error;
          }
        }
        if (increase > 0) {
          // The account is locked only now, briefly, so creates aren't held up by the provider call.
          await lockAccount(tx, accountId);
          const available = await billing.availableMicros(tx, accountId, { lock: true });
          if (available < increase) {
            // Funds were spent while the provider call ran: restore the provider deadline.
            await provider
              .setTimeout({ providerSandboxId: current.providerSandboxId!, expiresAt: current.expiresAt })
              .catch((e) => console.error(`restoring the deadline of ${sandboxId} failed:`, e));
            throw insufficient(increase, available);
          }
        }
        await tx.update(sandboxes).set({ expiresAt, holdMicros: hold }).where(eq(sandboxes.id, sandboxId));
      });
    } catch (error) {
      // Translated only after the transaction ended: translating may settle the sandbox.
      const failure = providerFailure as { error: unknown } | null;
      if (failure && failure.error === error) throw await translate(row, error);
      throw error;
    }
    return get(accountId, sandboxId);
  }

  /** Charges a locked, running sandbox and marks it ended. */
  async function settleLocked(tx: Tx, row: SandboxRow, endedAt: Date, reason: EndReason): Promise<void> {
    const billableEnd = Math.min(endedAt.getTime(), row.expiresAt.getTime());
    const cost = costMicros(row.ratePerHourMicros, billableEnd - row.billingStartedAt!.getTime());
    await billing.charge(tx, row, cost);
    await tx
      .update(sandboxes)
      .set({ status: 'ended', endedAt, endReason: reason, costMicros: cost, holdMicros: 0 })
      .where(eq(sandboxes.id, row.id));
  }

  /**
   * Ends a running sandbox's billing: charges from billingStartedAt until
   * min(endedAt, expiresAt), releases the hold, and marks it ended. Idempotent.
   */
  async function settle(sandboxId: string, endedAt: Date, reason: EndReason): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(LOCK_TIMEOUT);
      const [row] = await tx.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).for('update');
      if (row?.status === 'running') await settleLocked(tx, row, endedAt, reason);
    });
  }

  /** Kills and settles every sandbox past its deadline. Returns how many were settled. */
  async function settleExpired(limit = 100): Promise<number> {
    const due = await db
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(and(eq(sandboxes.status, 'running'), lte(sandboxes.expiresAt, new Date())))
      .orderBy(sandboxes.expiresAt)
      .limit(limit);
    let settled = 0;
    // A few at a time, so one slow provider kill doesn't hold up every other sandbox.
    const settleOne = async (id: string) => {
      try {
        const done = await db.transaction(async (tx) => {
          await tx.execute(LOCK_TIMEOUT);
          // Re-check under the lock: the deadline may have been extended since the select.
          // A sandbox whose timeout is being changed right now is skipped until the next pass.
          const [row] = await tx
            .select()
            .from(sandboxes)
            .where(and(eq(sandboxes.id, id), eq(sandboxes.status, 'running'), lte(sandboxes.expiresAt, new Date())))
            .for('update', { skipLocked: true });
          if (!row) return false;
          const provider = findProvider(row.provider);
          if (provider) {
            // The provider enforces its own deadline too, so settle even if this kill fails;
            // reconcile() kills anything left behind.
            await withTimeout(provider.kill(row.providerSandboxId!), `${provider.name} kill`).catch((e) =>
              console.error(`kill of expired ${id} failed:`, e),
            );
          } else {
            console.warn(`provider ${row.provider} is not configured; settling expired ${id} without killing it there`);
          }
          await settleLocked(tx, row, row.expiresAt, 'expired');
          return true;
        });
        if (done) settled++;
      } catch (error) {
        console.error(`settling expired ${id} failed:`, error);
      }
    };
    for (let i = 0; i < due.length; i += SETTLE_CONCURRENCY) {
      await Promise.all(due.slice(i, i + SETTLE_CONCURRENCY).map(({ id }) => settleOne(id)));
    }
    return settled;
  }

  /** Fails creates that never finished (e.g. the API process died mid-create). */
  async function failStuckCreates(olderThanMs = 10 * 60_000): Promise<number> {
    const failed = await db
      .update(sandboxes)
      .set({ status: 'failed', holdMicros: 0, endedAt: new Date(), endReason: 'create_failed', costMicros: 0 })
      .where(and(eq(sandboxes.status, 'creating'), lt(sandboxes.createdAt, new Date(Date.now() - olderThanMs))))
      .returning({ id: sandboxes.id });
    return failed.length;
  }

  /**
   * Compares each provider's sandboxes with ours:
   * - kills provider sandboxes we no longer consider running (leftovers from failed
   *   creates, failed kills, or a failover that actually succeeded on an earlier attempt);
   * - settles our running sandboxes that the provider no longer has, after confirming
   *   directly with the provider (listings can lag).
   * Provider sandboxes whose id we don't know belong to another deployment and are left alone.
   */
  async function reconcile(graceMs = 2 * 60_000): Promise<{ killed: number; lost: number }> {
    let killed = 0;
    let lost = 0;
    for (const provider of providers) {
      const listedAt = Date.now();
      let tagged;
      try {
        tagged = await withTimeout(provider.listTagged(), `${provider.name} list`);
      } catch (error) {
        console.error(`reconcile: listing ${provider.name} failed:`, error);
        continue;
      }
      const ids = [...new Set(tagged.map((t) => t.sandboxId))];
      const rows = ids.length ? await db.select().from(sandboxes).where(inArray(sandboxes.id, ids)) : [];
      const rowById = new Map(rows.map((r) => [r.id, r]));

      for (const t of tagged) {
        const row = rowById.get(t.sandboxId);
        if (!row) continue;
        const ours =
          row.status === 'creating' ||
          (row.status === 'running' && row.provider === provider.name && row.providerSandboxId === t.providerSandboxId);
        if (ours) continue;
        // Leave very recent rows alone: placement may still be writing its result.
        if (listedAt - row.createdAt.getTime() < graceMs) continue;
        await withTimeout(provider.kill(t.providerSandboxId), `${provider.name} kill`).then(
          () => killed++,
          (error) => console.error(`reconcile: killing ${t.providerSandboxId} failed:`, error),
        );
      }

      const listed = new Set(tagged.map((t) => t.providerSandboxId));
      const running = await db
        .select()
        .from(sandboxes)
        .where(and(eq(sandboxes.status, 'running'), eq(sandboxes.provider, provider.name)));
      for (const row of running) {
        if (listed.has(row.providerSandboxId!)) continue;
        if (listedAt - row.billingStartedAt!.getTime() < graceMs) continue;
        const alive = await withTimeout(provider.isAlive(row.providerSandboxId!), `${provider.name} status`).catch((error) => {
          console.error(`reconcile: checking ${row.id} failed:`, error);
          return true;
        });
        if (alive) continue;
        await settle(row.id, new Date(), 'lost');
        lost++;
      }
    }
    return { killed, lost };
  }

  return { create, get, list, live, kill, setTimeout, settle, settleExpired, failStuckCreates, reconcile };
}

export type SandboxService = ReturnType<typeof createSandboxService>;

/** True for Postgres' lock_not_available, also when wrapped by the query builder. */
function isLockNotAvailable(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === LOCK_NOT_AVAILABLE) return true;
  }
  return false;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
