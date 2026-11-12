import { createApiKey, createSandboxService, noBilling } from '@sr/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SandboxRouter, SandboxRouterError } from '../../sdk/src/index.ts';
import { createApp } from '../src/app.ts';
import { FakeProvider, closeTestDb, createAccount, resetDb, testDb } from '../../../test/helpers.ts';

const db = testDb();
afterAll(closeTestDb);

let client: SandboxRouter;
let provider: FakeProvider;

beforeEach(async () => {
  await resetDb();
  provider = new FakeProvider('e2b');
  const providers = [provider];
  const app = createApp({ db, providers, sandboxes: createSandboxService({ db, billing: noBilling, providers }) });
  const account = await createAccount();
  const { key } = await createApiKey(db, account, 'sdk');
  client = new SandboxRouter({
    apiKey: key,
    baseUrl: 'http://api.test',
    fetch: async (input, init) => app.request(input instanceof Request ? input : String(input), init),
  });
});

describe('SDK against the API', () => {
  it('covers the sandbox lifecycle', async () => {
    const sandbox = await client.sandboxes.create({ size: 'small', timeout: 300, metadata: { job: 'sdk' } });
    expect(sandbox.data).toMatchObject({ status: 'running', provider: 'e2b', metadata: { job: 'sdk' } });

    const result = await sandbox.exec('echo hello', { cwd: 'work', env: { A: '1' } });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain('cwd: /home/fake/work');

    const events = [];
    for await (const event of sandbox.execStream('exit 2')) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['stdout', 'stdout', 'stderr', 'exit']);
    expect(events.at(-1)).toMatchObject({ type: 'exit', exitCode: 2 });

    await sandbox.files.write('notes/a.txt', 'hi there');
    await sandbox.files.write('bin.dat', new Uint8Array([0, 1, 2, 255]));
    await sandbox.files.write(
      'streamed.txt',
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('from a stream'));
          controller.close();
        },
      }),
    );
    expect(await sandbox.files.readText('notes/a.txt')).toBe('hi there');
    expect([...(await sandbox.files.read('/home/fake/bin.dat'))]).toEqual([0, 1, 2, 255]);
    expect(await sandbox.files.readText('streamed.txt')).toBe('from a stream');
    expect((await sandbox.files.list('notes')).map((e) => e.name)).toEqual(['a.txt']);
    await sandbox.files.remove('notes/a.txt');

    await sandbox.startBackground('python3 -m http.server 8000');
    expect((await sandbox.portUrl(8000)).url).toContain('https://8000-');

    const before = sandbox.data.expiresAt;
    await sandbox.setTimeout(900);
    expect(sandbox.data.expiresAt > before).toBe(true);

    const page = await client.sandboxes.list({ status: 'running' });
    expect(page.data.map((s) => s.id)).toEqual([sandbox.id]);
    expect((await client.sandboxes.get(sandbox.id)).id).toBe(sandbox.id);

    const ended = await sandbox.kill();
    expect(ended).toMatchObject({ status: 'ended', endReason: 'killed' });
    // Self-hosted servers record cost without charging; the balance endpoint is Cloud-only.
    expect(ended.costUsd).toBeGreaterThanOrEqual(0);
  });

  it('raises typed errors', async () => {
    const sandbox = await client.sandboxes.create();
    const error = await sandbox.files.read('missing.txt').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxRouterError);
    expect(error).toMatchObject({ status: 404, code: 'file_not_found' });

    const tooLong = await client.sandboxes.create({ timeout: 10 }).catch((e: unknown) => e);
    expect(tooLong).toMatchObject({ status: 400, code: 'bad_request' });
  });

  it('lists providers', async () => {
    const providers = await client.providers();
    expect(providers[0]).toMatchObject({ name: 'e2b', sizes: expect.any(Array) });
  });
});
