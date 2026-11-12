import { describe, expect, it } from 'vitest';
import { providersFromEnv } from '../src/env.ts';
import { PROVIDER_NAMES, SIZES } from '../src/types.ts';

// Building providers must not call any provider: these keys are fake.
const all = {
  E2B_API_KEY: 'e2b_fake',
  DAYTONA_API_KEY: 'dtn_fake',
  DAYTONA_VM: 'true',
  MODAL_TOKEN_ID: 'ak-fake',
  MODAL_TOKEN_SECRET: 'as-fake',
  NOVITA_API_KEY: 'sk_fake',
  BOAT_API_KEY: 'boat_fake',
  VERCEL_TOKEN: 'vercel_fake',
  VERCEL_TEAM_ID: 'team_fake',
  VERCEL_PROJECT_ID: 'prj_fake',
};

describe('providersFromEnv', () => {
  it('offers nothing without keys', () => {
    expect(providersFromEnv({})).toEqual([]);
  });

  it('offers every provider whose keys are set, once each', () => {
    const names = providersFromEnv(all).map((p) => p.name);
    expect([...names].sort()).toEqual([...PROVIDER_NAMES].sort());
  });

  it('keeps Daytona VM and Modal VM opt-in and opt-out respectively', () => {
    const names = providersFromEnv({ ...all, DAYTONA_VM: undefined, MODAL_DISABLE_VM: 'true' }).map((p) => p.name);
    expect(names).not.toContain('daytona-vm');
    expect(names).not.toContain('modal-vm');
    expect(names).toContain('modal-gvisor');
  });

  it('rejects incomplete Vercel credentials and bad lifetimes', () => {
    expect(() => providersFromEnv({ VERCEL_TOKEN: 'x' })).toThrow(/VERCEL_TEAM_ID/);
    expect(() => providersFromEnv({ BOAT_API_KEY: 'x', BOAT_MAX_LIFETIME_HOURS: '0' })).toThrow(/BOAT_MAX_LIFETIME_HOURS/);
  });

  it('gives every size real resources and a positive price on every provider', () => {
    for (const provider of providersFromEnv(all)) {
      for (const size of SIZES) {
        const resources = provider.resources(size);
        expect(resources.cpu, `${provider.name} ${size}`).toBeGreaterThan(0);
        expect(resources.memoryMib, `${provider.name} ${size}`).toBeGreaterThan(0);
        expect(provider.ratePerHourMicros(resources), `${provider.name} ${size}`).toBeGreaterThan(0);
      }
      expect(provider.maxLifetimeSeconds).toBeGreaterThan(0);
    }
  });
});
