import type { Resources } from './types.ts';

/** A provider's published list prices, in micro-USD per hour. */
export interface PriceSheet {
  cpuPerHour: number;
  memoryGibPerHour: number;
  diskGibPerHour: number;
  /** Disk included at no charge, per sandbox. */
  freeDiskGib: number;
}

/** Hourly price for the given resources, rounded up to a whole micro-USD. */
export function ratePerHour(prices: PriceSheet, resources: Resources): number {
  const memoryGib = resources.memoryMib / 1024;
  const billableDiskGib =
    resources.diskMib === null ? 0 : Math.max(0, resources.diskMib / 1024 - prices.freeDiskGib);
  return Math.ceil(
    resources.cpu * prices.cpuPerHour +
      memoryGib * prices.memoryGibPerHour +
      billableDiskGib * prices.diskGibPerHour,
  );
}
