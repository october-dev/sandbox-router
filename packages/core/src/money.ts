export const MICROS_PER_USD = 1_000_000;
const MS_PER_HOUR = 3_600_000;

/** Cost of running at `ratePerHourMicros` for `ms` milliseconds, rounded up to a whole micro-USD. */
export function costMicros(ratePerHourMicros: number, ms: number): number {
  if (ms <= 0) return 0;
  return Math.ceil((ratePerHourMicros * ms) / MS_PER_HOUR);
}

export function microsToUsd(micros: number): number {
  return micros / MICROS_PER_USD;
}
