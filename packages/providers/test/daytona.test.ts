import { describe, expect, it, vi } from 'vitest';

// A fake Daytona client: no real provider is called.
const executed: string[] = [];
const fakeSandbox = {
  id: 'sbx',
  state: 'started',
  process: {
    createSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    executeSessionCommand: vi.fn(async (_session: string, request: { command: string }) => {
      executed.push(request.command);
      return { cmdId: 'cmd' };
    }),
  },
};

vi.mock('@daytona/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@daytona/sdk')>();
  return {
    ...actual,
    Daytona: class {
      get = async () => fakeSandbox;
    },
  };
});

const { createDaytonaProvider } = await import('../src/daytona.ts');

const ref = { providerSandboxId: 'sbx', expiresAt: new Date(Date.now() + 60_000) };

describe('daytona provider', () => {
  it('rejects an environment variable name that would inject shell syntax', async () => {
    const daytona = createDaytonaProvider({ apiKey: 'fake' });
    const request = {
      command: 'true',
      cwd: '/home/daytona',
      env: { 'A=1;touch /tmp/pwned;B': 'x' },
      timeoutMs: 5_000,
      onStdout: () => {},
      onStderr: () => {},
      signal: new AbortController().signal,
    };
    await expect(daytona.exec(ref, request)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(daytona.startBackground(ref, request)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(executed).toEqual([]);
  });
});
