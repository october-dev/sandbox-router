import { createHash, randomBytes } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function randomString(alphabet: string, length: number): string {
  // Rejection sampling keeps every character uniformly distributed.
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

/** Sandbox ids are lowercase so they are valid in provider labels and idempotency keys. */
export function newSandboxId(): string {
  return `sbx_${randomString(BASE32, 20)}`;
}

/** API keys carry ~190 bits of randomness. */
export function newApiKey(): string {
  return `sr_${randomString(BASE62, 32)}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
