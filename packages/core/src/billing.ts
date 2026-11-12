import type { Tx } from '@sr/db';
import type { SandboxRow } from './sandboxes.ts';

/**
 * How the sandbox lifecycle pays for sandboxes. The lifecycle decides how much a
 * sandbox reserves and costs; billing decides whether the account can afford it and
 * records the charge.
 *
 * Both methods run inside the lifecycle's transaction, under its locking rules:
 * the sandbox row (when there is one) is already locked, and the account row is
 * locked before `availableMicros` is called with `lock: true`.
 */
export interface Billing {
  /**
   * Funds the account can still reserve: its balance minus what its creating and
   * running sandboxes already hold. With `lock: true`, lock whatever serializes
   * reservations for the account, so two requests can't spend the same funds.
   */
  availableMicros(tx: Tx, accountId: string, options: { lock: boolean }): Promise<number>;
  /** Records the final cost of a sandbox. Called exactly once, in the transaction that ends it. */
  charge(tx: Tx, row: SandboxRow, costMicros: number): Promise<void>;
}

/**
 * For self-hosted deployments: nothing is refused for lack of funds and nothing is
 * charged. Each sandbox still records its rate, reserved cost and final cost, so
 * the operator can see what it would have cost.
 */
export const noBilling: Billing = {
  async availableMicros() {
    return Number.POSITIVE_INFINITY;
  },
  async charge() {},
};
