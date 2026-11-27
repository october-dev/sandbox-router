import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBoatProvider } from '../src/boat.ts';
import { ProviderError } from '../src/errors.ts';

// A fake boat API on loopback: no real provider is called.
let server: Server;
let origin = '';
let secretHits = 0;
let stopHits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/v1/sandboxes/sbx/files/download-url') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'file.download_url', url: `${origin}/signed`, method: 'GET', path: '/home/user/a', expiresAt: new Date().toISOString() }));
    } else if (req.url === '/signed') {
      // What a user who controls the sandbox's file server could answer.
      res.writeHead(302, { location: `${origin}/internal-secret` });
      res.end();
    } else if (req.method === 'POST' && req.url === '/api/v1/sandboxes/sbx/commands') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'command.started', success: true, processId: 7, pid: 70, command: 'x', startedAt: new Date().toISOString() }));
    } else if (req.url?.startsWith('/api/v1/sandboxes/sbx/commands/7/stream')) {
      // One line of output, then the command keeps running.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ type: 'stdout', data: 'hello', nextOffset: 5 })}\n`);
      req.on('close', () => res.end());
    } else if (req.method === 'DELETE' && req.url === '/api/v1/sandboxes/sbx/commands/7') {
      stopHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, processId: 7 }));
    } else if (req.url === '/api/v1/sandboxes/sbx/files/upload-url') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'file.upload_url', url: `${origin}/signed-upload`, method: 'PUT', path: '/home/user/a', expiresAt: new Date().toISOString() }));
    } else if (req.url === '/signed-upload') {
      // A sandbox file server that reads the whole upload and never answers.
      req.resume();
    } else if (req.url === '/internal-secret') {
      secretHits++;
      res.end('secret');
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ref = { providerSandboxId: 'sbx', expiresAt: new Date(Date.now() + 60_000) };

describe('boat provider', () => {
  it('does not follow redirects from a signed file URL', async () => {
    const boat = createBoatProvider({ apiKey: 'fake', baseUrl: `${origin}/api/v1/`, maxLifetimeSeconds: 7200 });
    await expect(boat.readFile(ref, '/home/user/a')).rejects.toBeInstanceOf(ProviderError);
    expect(secretHits).toBe(0);
  });

  it('rejects an environment variable name that would inject shell syntax', async () => {
    const boat = createBoatProvider({ apiKey: 'fake', baseUrl: `${origin}/api/v1`, maxLifetimeSeconds: 7200 });
    const request = {
      command: 'true',
      cwd: '/home/user',
      env: { 'A=1;touch /tmp/pwned;B': 'x' },
      timeoutMs: 5_000,
      onStdout: () => {},
      onStderr: () => {},
      signal: new AbortController().signal,
    };
    await expect(boat.exec(ref, request)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(boat.startBackground(ref, request)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('stops the detached command when an output callback fails', async () => {
    const boat = createBoatProvider({ apiKey: 'fake', baseUrl: `${origin}/api/v1`, maxLifetimeSeconds: 7200 });
    const request = {
      command: 'sleep 1000',
      cwd: '/home/user',
      env: {},
      timeoutMs: 30_000,
      onStdout: () => {
        throw new Error('client went away');
      },
      onStderr: () => {},
      signal: new AbortController().signal,
    };
    await expect(boat.exec(ref, request)).rejects.toThrow();
    await expect.poll(() => stopHits).toBe(1);
  });

  it('gives up on a signed upload URL that never answers', async () => {
    const boat = createBoatProvider({ apiKey: 'fake', baseUrl: `${origin}/api/v1`, maxLifetimeSeconds: 7200, fileResponseTimeoutMs: 200 });
    const data = new Response('hello').body!;
    await expect(boat.writeFile(ref, '/home/user/a', data)).rejects.toBeInstanceOf(ProviderError);
  }, 5_000);
});
