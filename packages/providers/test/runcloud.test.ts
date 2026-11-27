import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/errors.ts';
import { createRunCloudProvider } from '../src/runcloud.ts';
import { SANDBOX_ID_LABEL } from '../src/types.ts';

// A fake run.cloud API on loopback: no real provider is called.
let server: Server;
let apiUrl = '';
let tunnelCount = 0;
const requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: unknown }> = [];

const sandbox = (id: string, state: string, tags: Record<string, string> = {}) => ({
  id,
  state,
  milli_cpu: 1000,
  mem_mb: 1024,
  created_at: '2026-11-27T12:00:00.000Z',
  tags,
});

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url === '/run-cloud/sandboxes') return json(201, sandbox('sbx_new', 'running'));
    if (req.method === 'GET' && req.url?.startsWith('/run-cloud/sandboxes?')) {
      // The API filters by state; the label is matched by the provider.
      const state = new URL(req.url, 'http://x').searchParams.get('state');
      const items =
        state === 'running'
          ? [sandbox('sbx_ours', 'running', { [SANDBOX_ID_LABEL]: 'sr_1' }), sandbox('sbx_other', 'running')]
          : state === 'paused'
            ? [sandbox('sbx_parked', 'paused', { [SANDBOX_ID_LABEL]: 'sr_2' })]
            : [];
      return json(200, { items });
    }
    const tunnelPath = /^\/run-cloud\/sandboxes\/sbx_t\/tunnels(\/.*)?$/.exec(req.url ?? '');
    if (tunnelPath && req.method === 'POST') {
      const { port, ttlSeconds } = JSON.parse(raw) as { port: number; ttlSeconds: number };
      tunnelCount++;
      return json(201, {
        id: `tun_${tunnelCount}`,
        sandboxId: 'sbx_t',
        hostname: `t${tunnelCount}.example`,
        url: `https://t${tunnelCount}.example`,
        port,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      });
    }
    if (tunnelPath && req.method === 'DELETE') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'DELETE' && req.url === '/run-cloud/sandboxes/sbx_missing') return json(404, { detail: 'Not found' });
    if (req.method === 'GET' && req.url === '/run-cloud/sandboxes/sbx_missing') return json(404, { detail: 'Not found' });
    if (req.method === 'POST' && req.url === '/run-cloud/sandboxes/sbx_busy/timeout') return json(429, { detail: 'slow down' });
    json(500, { detail: 'unexpected request' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const provider = () => createRunCloudProvider({ apiKey: 'rc_fake', apiUrl });

describe('run.cloud provider', () => {
  it('creates an exactly sized, labelled sandbox that is destroyed at its deadline and never idle-paused', async () => {
    const created = await provider().create({ size: 'small', timeoutSeconds: 600, sandboxId: 'sr_abc' });
    expect(created).toMatchObject({ providerSandboxId: 'sbx_new', cpu: 1, memoryMib: 1024, homeDir: '/root' });
    const request = requests.find((r) => r.method === 'POST' && r.url === '/run-cloud/sandboxes')!;
    expect(request.headers['idempotency-key']).toBe('sr_abc');
    expect(request.body).toMatchObject({
      cpu: 1,
      memory: 1024,
      timeoutSeconds: 720,
      onTimeout: 'destroy',
      idlePauseSeconds: 0,
      tags: { [SANDBOX_ID_LABEL]: 'sr_abc' },
    });
  });

  it('lists undestroyed sandboxes that carry our label, without paging through destroyed ones', async () => {
    expect(await provider().listTagged()).toEqual([
      { providerSandboxId: 'sbx_ours', sandboxId: 'sr_1' },
      { providerSandboxId: 'sbx_parked', sandboxId: 'sr_2' },
    ]);
    const lists = requests.filter((r) => r.method === 'GET' && r.url.startsWith('/run-cloud/sandboxes'));
    expect(lists.every((r) => r.url.includes('state='))).toBe(true);
  });

  it('treats a missing sandbox as already killed and not alive', async () => {
    await expect(provider().kill('sbx_missing')).resolves.toBeUndefined();
    await expect(provider().isAlive('sbx_missing')).resolves.toBe(false);
  });

  it('maps a rate limit to rate_limited', async () => {
    const ref = { providerSandboxId: 'sbx_busy', expiresAt: new Date(Date.now() + 60_000) };
    await expect(provider().setTimeout(ref)).rejects.toBeInstanceOf(ProviderError);
    await expect(provider().setTimeout(ref)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('reuses an open tunnel for a port until the sandbox outlives it', async () => {
    const p = provider();
    const ref = { providerSandboxId: 'sbx_t', expiresAt: new Date(Date.now() + 600_000) };
    const first = await p.portUrl(ref, 8000);
    expect(await p.portUrl(ref, 8000)).toEqual(first);
    expect(tunnelCount).toBe(1);
    // A later deadline needs a tunnel that lasts longer; the old one is closed.
    ref.expiresAt = new Date(Date.now() + 3_600_000);
    const second = await p.portUrl(ref, 8000);
    expect(second.url).not.toBe(first.url);
    expect(tunnelCount).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/run-cloud/sandboxes/sbx_t/tunnels/tun_1')).toBe(true);
  });

  it('prices at the published per-second rates', () => {
    const p = provider();
    // 1 vCPU is half a core at $0.00000492/s, plus 1 GiB at $0.00000083175/s.
    expect(p.ratePerHourMicros(p.resources('small'))).toBe(11_851);
  });
});
