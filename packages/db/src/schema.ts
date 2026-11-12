import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// All money is stored as integer micro-USD ("micros"): 1 USD = 1_000_000 micros.
// bigint mode 'number' is exact up to 2^53 micros (~9 billion USD).
const micros = (name: string) => bigint(name, { mode: 'number' });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

// Every table enables row level security with no policies. Supabase exposes the
// public schema through its Data API; RLS without policies denies that path entirely,
// while our server connects as the table owner and is unaffected.

export const SANDBOX_STATUSES = ['creating', 'running', 'ended', 'failed'] as const;
export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

export const END_REASONS = ['killed', 'expired', 'lost', 'create_failed'] as const;
export type EndReason = (typeof END_REASONS)[number];

/**
 * Who sandboxes and API keys belong to. In Cloud, one per dashboard user (`id` is
 * the Supabase Auth user id). Self-hosted deployments have one owner account.
 * Locking this row serializes reservations for the account (see the lifecycle's
 * locking rules), so billing implementations can rely on it.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
).enableRLS();

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the key, safe to display. */
    prefix: text('prefix').notNull(),
    /** SHA-256 hex digest of the full key. The key itself is never stored. */
    hash: text('hash').notNull().unique(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastUsedAt: timestamptz('last_used_at'),
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [index('api_keys_account_idx').on(t.accountId)],
).enableRLS();

export const sandboxes = pgTable(
  'sandboxes',
  {
    id: text('id').primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    status: text('status', { enum: SANDBOX_STATUSES }).notNull(),
    size: text('size').notNull(),
    /** Routing preset used, or null when the caller pinned a provider. */
    preset: text('preset'),
    /** Provider the sandbox was placed on. Null until placement succeeds. */
    provider: text('provider'),
    providerSandboxId: text('provider_sandbox_id'),
    /** Resources reported by the provider after creation. */
    cpu: integer('cpu'),
    memoryMib: integer('memory_mib'),
    diskMib: integer('disk_mib'),
    homeDir: text('home_dir'),
    /** Price per hour while running, fixed at placement. */
    ratePerHourMicros: micros('rate_per_hour_micros').notNull().default(0),
    /**
     * Cost of the full timeout, reserved until the sandbox is settled. Billing
     * implementations subtract it from what the account can spend; self-hosted
     * deployments only report it.
     */
    holdMicros: micros('hold_micros').notNull().default(0),
    /** Cost accrues from this instant until min(endedAt, expiresAt). */
    billingStartedAt: timestamptz('billing_started_at'),
    expiresAt: timestamptz('expires_at').notNull(),
    endedAt: timestamptz('ended_at'),
    endReason: text('end_reason', { enum: END_REASONS }),
    costMicros: micros('cost_micros'),
    metadata: jsonb('metadata').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sandboxes_account_created_idx').on(t.accountId, t.createdAt),
    index('sandboxes_status_expires_idx').on(t.status, t.expiresAt),
    uniqueIndex('sandboxes_provider_ref_idx').on(t.provider, t.providerSandboxId),
    check('sandboxes_hold_nonneg', sql`${t.holdMicros} >= 0`),
    check('sandboxes_rate_nonneg', sql`${t.ratePerHourMicros} >= 0`),
    check('sandboxes_status_valid', sql.raw(`status in (${quoted(SANDBOX_STATUSES)})`)),
    check('sandboxes_end_reason_valid', sql.raw(`end_reason in (${quoted(END_REASONS)})`)),
  ],
).enableRLS();

/** Every placement attempt, used for routing (latency, recent failures) and debugging. */
export const createAttempts = pgTable(
  'create_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sandboxId: text('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    provider: text('provider').notNull(),
    size: text('size').notNull(),
    ok: boolean('ok').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    error: text('error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('create_attempts_provider_created_idx').on(t.provider, t.createdAt)],
).enableRLS();
