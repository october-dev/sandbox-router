// The self-hosted server as `node src/self-hosted.ts` runs it, over real HTTP:
// migrations, the owner account, the admin token, the worker and the SDK.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxRouter, SandboxRouterError } from '../../sdk/src/index.ts';
import { MAX_CONCURRENT_OPERATIONS_PER_ACCOUNT } from '../src/routes/sandboxes.ts';
import { parseSelfHostedEnv, startSelfHosted, type SelfHostedServer } from '../src/self-hosted-server.ts';
import { FakeProvider, closeTestDb, resetDb } from '../../../test/helpers.ts';

const ADMIN_TOKEN = 'self-hosted-admin-token-'.padEnd(48, 'z');
let server: SelfHostedServer;
let provider: FakeProvider;
let base = '';

beforeAll(async () => {
  await resetDb();
  provider = new FakeProvider('e2b');
  server = await startSelfHosted(
    { DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_TOKEN, PORT: '0', HOST: '127.0.0.1', MAX_RUNNING_SANDBOXES: '2' },
    { providers: [provider] },
  );
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await closeTestDb();
});

async function newKey(): Promise<string> {
  const res = await fetch(`${base}/v1/api-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'e2e' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { key: string }).key;
}

describe('self-hosted server over HTTP', () => {
  it('serves health, the OpenAPI document and the reference page without a key', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/sandboxes', '/v1/sandboxes/{id}/exec', '/v1/api-keys', '/v1/providers']),
    );
    const docs = await fetch(`${base}/docs`);
    expect(docs.status).toBe(200);
    expect(docs.headers.get('content-type')).toContain('text/html');
  });

  it('requires credentials for everything else', async () => {
    expect((await fetch(`${base}/v1/sandboxes`)).status).toBe(401);
    expect((await fetch(`${base}/v1/api-keys`, { headers: { authorization: 'Bearer sr_nope' } })).status).toBe(401);
  });

  it('runs a sandbox end to end with an API key the admin token created', async () => {
    const router = new SandboxRouter({ apiKey: await newKey(), baseUrl: base });
    const sandbox = await router.sandboxes.create({ size: 'small', preset: 'cheap', timeout: 600 });
    expect(sandbox.data).toMatchObject({ status: 'running', provider: 'e2b' });

    expect((await sandbox.exec('echo hi')).stdout).toContain('ran: echo hi');
    const events = [];
    for await (const event of sandbox.execStream('exit 3')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'exit', exitCode: 3 });

    await sandbox.files.write('a/b.txt', 'hello');
    expect(await sandbox.files.readText('a/b.txt')).toBe('hello');

    const ended = await sandbox.kill();
    expect(ended).toMatchObject({ status: 'ended', endReason: 'killed' });
  });

  it('kills a streamed command when the client disconnects', async () => {
    const router = new SandboxRouter({ apiKey: await newKey(), baseUrl: base });
    const sandbox = await router.sandboxes.create();
    const before = provider.abortedCommands;
    const controller = new AbortController();
    const reading = (async () => {
      for await (const _ of sandbox.execStream('sleep', { timeout: 30, signal: controller.signal })) {
        // The fake command prints nothing until it ends.
      }
    })().catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await reading;
    await expect.poll(() => provider.abortedCommands, { timeout: 5_000 }).toBe(before + 1);
    await sandbox.kill();
  });

  it('limits concurrent commands per account and frees the slots when they end', async () => {
    const router = new SandboxRouter({ apiKey: await newKey(), baseUrl: base });
    const sandbox = await router.sandboxes.create();
    const controllers = Array.from({ length: MAX_CONCURRENT_OPERATIONS_PER_ACCOUNT }, () => new AbortController());
    const streams = controllers
      .map(async (controller) => {
        for await (const _ of sandbox.execStream('sleep', { timeout: 30, signal: controller.signal })) {
          // Nothing until it ends.
        }
      })
      .map((p) => p.catch(() => {}));
    try {
      // Every stream holds a slot once its command is running.
      await expect.poll(() => provider.runningCommands, { timeout: 15_000 }).toBe(MAX_CONCURRENT_OPERATIONS_PER_ACCOUNT);
      const over = await sandbox.exec('echo over').catch((e: unknown) => e);
      expect(over).toMatchObject({ status: 429, code: 'limit_exceeded' });
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(streams);
    }
    await expect
      .poll(async () => (await sandbox.exec('echo again').catch(() => null))?.exitCode, { timeout: 5_000 })
      .toBe(0);
    await sandbox.kill();
  });

  it('runs a long exec over a stream, past the fetch header timeout', async () => {
    const router = new SandboxRouter({ apiKey: await newKey(), baseUrl: base });
    const sandbox = await router.sandboxes.create();
    const result = await sandbox.exec('exit 4', { timeout: 1800 });
    expect(result).toMatchObject({ exitCode: 4, timedOut: false, truncated: false });
    expect(result.stdout).toContain('ran: exit 4');
    expect(result.stderr).toBe('warning\n');
    await sandbox.kill();
  });

  it('enforces MAX_RUNNING_SANDBOXES and rejects oversized JSON bodies', async () => {
    const key = await newKey();
    const router = new SandboxRouter({ apiKey: key, baseUrl: base });
    // Sandboxes left running by an earlier failed test would use up the limit.
    for (const left of (await router.sandboxes.list({ status: 'running' })).data) {
      await (await router.sandboxes.get(left.id)).kill();
    }
    const running = [await router.sandboxes.create(), await router.sandboxes.create()];
    const third = await router.sandboxes.create().catch((e: unknown) => e);
    expect(third).toBeInstanceOf(SandboxRouterError);
    expect(third).toMatchObject({ status: 429, code: 'limit_exceeded' });

    // In process: over a socket the server answers 413 before reading the body and closes the connection.
    const res = await server.app.request(`/v1/sandboxes/${running[0]!.id}/exec`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    for (const sandbox of running) await sandbox.kill();
  });
});

describe('self-hosted settings', () => {
  it('rejects a short admin token and treats empty variables as unset', () => {
    expect(() => parseSelfHostedEnv({ DATABASE_URL: 'postgres://x', ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
    expect(() => parseSelfHostedEnv({ DATABASE_URL: 'postgres://x', ADMIN_TOKEN: `sr_${'a'.repeat(40)}` })).toThrow(/sr_/);
    const env = parseSelfHostedEnv({ DATABASE_URL: 'postgres://x', ADMIN_TOKEN: 'a'.repeat(32), PORT: '', MAX_RUNNING_SANDBOXES: '' });
    expect(env).toMatchObject({ PORT: 8787, MAX_RUNNING_SANDBOXES: 10 });
  });

  it('refuses to start without a provider', async () => {
    await expect(
      startSelfHosted({ DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_TOKEN: 'a'.repeat(32) }),
    ).rejects.toThrow(/at least one provider/);
  });
});
