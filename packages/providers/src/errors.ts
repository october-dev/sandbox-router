import type { ProviderName } from './types.ts';

export type ProviderErrorCode =
  /** The sandbox no longer exists on the provider. */
  | 'sandbox_not_found'
  /** A path inside the sandbox does not exist. */
  | 'file_not_found'
  /** The provider refused because of a rate, concurrency or quota limit. */
  | 'rate_limited'
  /** The provider is failing, unreachable, timed out, or rejected our credentials. */
  | 'unavailable'
  /** The provider rejected the request itself (bad path, disk full, invalid argument). */
  | 'invalid_request'
  | 'unknown';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: ProviderName;

  constructor(provider: ProviderName, code: ProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
