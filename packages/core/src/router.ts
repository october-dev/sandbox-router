import { createAttempts, type Db } from '@sr/db';
import type { Provider, ProviderName, Size } from '@sr/providers';
import { sql } from 'drizzle-orm';

export const PRESETS = ['cheap', 'fast'] as const;
export type Preset = (typeof PRESETS)[number];

/** Recent placement history for one provider. */
export interface ProviderHealth {
  /** Median create latency of recent successful placements, or null without data. */
  medianCreateMs: number | null;
  /** Share of recent placements that succeeded, or null without data. */
  successRate: number | null;
  /** True when the most recent attempts all failed within a short window. */
  failing: boolean;
}

const RECENT_ATTEMPTS = 20;
const FAILING_STREAK = 3;
const FAILING_WINDOW_MS = 10 * 60_000;

export async function loadProviderHealth(db: Db): Promise<Map<string, ProviderHealth>> {
  const rows = await db.execute<{ provider: string; ok: boolean; latency_ms: number; created_at: Date }>(sql`
    select provider, ok, latency_ms, created_at from (
      select provider, ok, latency_ms, created_at,
             row_number() over (partition by provider order by created_at desc) as rn
      from ${createAttempts}
      where created_at > now() - interval '24 hours'
    ) recent
    where rn <= ${RECENT_ATTEMPTS}
    order by provider, created_at desc
  `);

  const byProvider = new Map<string, Array<{ ok: boolean; latencyMs: number; createdAt: Date }>>();
  for (const row of rows.rows) {
    const list = byProvider.get(row.provider) ?? [];
    list.push({ ok: row.ok, latencyMs: row.latency_ms, createdAt: new Date(row.created_at) });
    byProvider.set(row.provider, list);
  }

  const health = new Map<string, ProviderHealth>();
  for (const [provider, attempts] of byProvider) {
    const latencies = attempts
      .filter((a) => a.ok)
      .map((a) => a.latencyMs)
      .sort((a, b) => a - b);
    const streak = attempts.slice(0, FAILING_STREAK);
    health.set(provider, {
      medianCreateMs: latencies.length > 0 ? (latencies[Math.floor(latencies.length / 2)] ?? null) : null,
      successRate: attempts.filter((a) => a.ok).length / attempts.length,
      failing:
        streak.length === FAILING_STREAK &&
        streak.every((a) => !a.ok && Date.now() - a.createdAt.getTime() < FAILING_WINDOW_MS),
    });
  }
  return health;
}

export interface RouteRequest {
  size: Size;
  timeoutSeconds: number;
  preset: Preset;
  /** When set, only this provider is considered. */
  provider?: ProviderName;
}

/**
 * Orders the providers that can host the request, best first. Providers that are
 * currently failing stay in the list but move to the end, as a last resort.
 */
export function rankProviders(
  providers: readonly Provider[],
  health: ReadonlyMap<string, ProviderHealth>,
  request: RouteRequest,
): Provider[] {
  const eligible = providers.filter(
    (p) => (!request.provider || p.name === request.provider) && p.maxLifetimeSeconds >= request.timeoutSeconds,
  );
  const price = (p: Provider) => p.ratePerHourMicros(p.resources(request.size));
  const latency = (p: Provider) => health.get(p.name)?.medianCreateMs ?? Number.POSITIVE_INFINITY;
  const failing = (p: Provider) => (health.get(p.name)?.failing ? 1 : 0);

  return eligible.toSorted((a, b) => {
    const byHealth = failing(a) - failing(b);
    if (byHealth !== 0) return byHealth;
    const byPrice = price(a) - price(b);
    const byLatency = latency(a) - latency(b);
    if (request.preset === 'cheap') return byPrice || byLatency || 0;
    return byLatency || byPrice || 0;
  });
}
