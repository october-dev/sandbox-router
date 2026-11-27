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

describe('paths that look like options', () => {
  it('passes cwd after -- so cd never reads it as an option', async () => {
    executed.length = 0;
    const daytona = createDaytonaProvider({ apiKey: 'fake' });
    const controller = new AbortController();
    const request = {
      command: 'true',
      cwd: '-P',
      env: {},
      timeoutMs: 5_000,
      onStdout: () => {},
      onStderr: () => {},
      signal: controller.signal,
    };
    await daytona.startBackground(ref, request);
    expect(executed[0]).toMatch(/^cd -- '-P' && /);
  });
});
