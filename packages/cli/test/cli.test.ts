// The CLI as a user runs it: a separate process talking HTTP to the self-hosted server,
// which runs in this process with an in-memory provider.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startSelfHosted, type SelfHostedServer } from '../../server/src/self-hosted-server.ts';
import { FakeProvider, closeTestDb, resetDb } from '../../../test/helpers.ts';

const ADMIN_TOKEN = 'cli-test-admin-token-'.padEnd(48, 'x');
const CLI = join(import.meta.dirname, '../src/index.ts');

let server: SelfHostedServer;
let provider: FakeProvider;
let base = '';
let dir = '';
let configFile = '';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], options: { input?: string | Buffer; env?: Record<string, string>; cwd?: string } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=sandboxrouter-source', CLI, ...args], {
      cwd: options.cwd ?? dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        SANDBOXROUTER_CONFIG: configFile,
        ...options.env,
      },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
    child.stdin.end(options.input ?? '');
  });
}

beforeAll(async () => {
  await resetDb();
  provider = new FakeProvider('e2b');
  server = await startSelfHosted(
    { DATABASE_URL: process.env.TEST_DATABASE_URL, ADMIN_TOKEN, PORT: '0', HOST: '127.0.0.1' },
    { providers: [provider] },
  );
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  await closeTestDb();
});

beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'sr-cli-'));
  configFile = join(dir, 'config', 'sandboxrouter', 'config.json');
});

async function login() {
  const result = await cli(['login', base, '--with-key'], { input: ADMIN_TOKEN });
  expect(result.stderr).toContain(`Logged in to ${base}`);
  expect(result.code).toBe(0);
}

async function createSandbox(...args: string[]): Promise<string> {
  const result = await cli(['create', ...args]);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe('login', { timeout: 60_000 }, () => {
  it('creates an API key with the admin token and saves only the key, readable by the owner only', async () => {
    await login();
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { default: string; servers: Record<string, { apiKey: string }> };
    expect(config.default).toBe(base);
    expect(config.servers[base]!.apiKey).toMatch(/^sr_/);
    expect(readFileSync(configFile, 'utf8')).not.toContain(ADMIN_TOKEN);
    expect(statSync(configFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'config', 'sandboxrouter')).mode & 0o777).toBe(0o700);

    const status = await cli(['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(`server   ${base}`);
    expect(status.stdout).toContain(`(from ${configFile})`);

    const logout = await cli(['logout']);
    expect(logout.code).toBe(0);
    expect(() => statSync(configFile)).toThrow();
    expect((await cli(['list'])).stderr).toContain('No server configured');
  });

  it('accepts an API key, and rejects a wrong one', async () => {
    await login();
    const { apiKey } = JSON.parse(readFileSync(configFile, 'utf8')).servers[base];
    rmSync(configFile);
    const ok = await cli(['login', `${base}/`, '--with-key'], { input: `${apiKey}\n` });
    expect(ok.code, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).servers[base].apiKey).toBe(apiKey);

    const bad = await cli(['login', base, '--with-key'], { input: 'sr_not_a_key' });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Invalid or revoked API key');
  });

  it('asks for --with-key when the server has no browser login and there is no terminal', async () => {
    const result = await cli(['login', base]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('has no browser login');
    expect(result.stderr).toContain('--with-key');
  });

  it('logs in through the browser on servers that offer it', async () => {
    let polls = 0;
    const requests: string[] = [];
    const fake: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      req.on('end', () => {
        requests.push(`${req.method} ${req.url} ${body}`);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/v1/cli/login') {
          res.end(JSON.stringify({ deviceCode: 'dev-1', userCode: 'ABCD-EFGH', verificationUrl: 'https://dash.test/cli', expiresIn: 60, interval: 1 }));
        } else if (req.url === '/v1/cli/login/token') {
          if (++polls === 1) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: { code: 'authorization_pending', message: 'pending' } }));
          } else {
            res.end(JSON.stringify({ apiKey: 'sr_from_browser', keyName: 'CLI (test)', email: 'dev@example.com' }));
          }
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    try {
      const result = await cli(['login', url]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('https://dash.test/cli');
      expect(result.stderr).toContain('ABCD-EFGH');
      expect(result.stderr).toContain('as dev@example.com');
      expect(JSON.parse(readFileSync(configFile, 'utf8')).servers[url].apiKey).toBe('sr_from_browser');
      expect(requests[0]).toMatch(/^POST \/v1\/cli\/login \{"clientName":".+"\}$/);
      expect(requests.slice(1)).toEqual(Array(2).fill('POST /v1/cli/login/token {"deviceCode":"dev-1"}'));
    } finally {
      fake.close();
    }
  });

  it('never sends a saved key to another server', async () => {
    await login();
    const result = await cli(['list', '--base-url', 'http://127.0.0.1:9']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Not logged in to http://127.0.0.1:9');
  });

  it('uses the key and server from the environment', async () => {
    await login();
    const { apiKey } = JSON.parse(readFileSync(configFile, 'utf8')).servers[base];
    rmSync(configFile);
    const result = await cli(['list', '--json'], { env: { SANDBOXROUTER_API_KEY: apiKey, SANDBOXROUTER_BASE_URL: base } });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.any(Array));

    const wrong = await cli(['list'], { env: { SANDBOXROUTER_API_KEY: 'sr_wrong', SANDBOXROUTER_BASE_URL: base } });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('Check SANDBOXROUTER_API_KEY');
  });
});

describe('sandboxes', { timeout: 60_000 }, () => {
  beforeEach(login);

  it('creates, lists, shows, extends and kills a sandbox', async () => {
    const id = await createSandbox('--size', 'small', '--preset', 'cheap', '--timeout', '10m', '--metadata', 'job=cli');
    expect(id).toMatch(/^sbx_/);

    const list = await cli(['list']);
    expect(list.stdout).toMatch(new RegExp(`^ID +STATUS +PROVIDER`));
    expect(list.stdout).toContain(id);
    expect((await cli(['ls', '-q'])).stdout.trim().split('\n')).toContain(id);

    const got = JSON.parse((await cli(['get', id, '--json'])).stdout);
    expect(got).toMatchObject({ id, status: 'running', size: 'small', provider: 'e2b', metadata: { job: 'cli' } });
    expect((await cli(['get', id])).stdout).toContain('meta.job  cli');

    const extended = JSON.parse((await cli(['timeout', id, '1h', '--json'])).stdout);
    expect(new Date(extended.expiresAt).getTime()).toBeGreaterThan(new Date(got.expiresAt).getTime());

    const url = await cli(['url', id, '8000']);
    expect(url.stdout.trim()).toMatch(/^https:\/\/8000-.+\.fake\.test$/);

    const killed = await cli(['kill', id]);
    expect(killed.code).toBe(0);
    expect(killed.stderr).toContain(`Killed ${id}`);
    expect(JSON.parse((await cli(['get', id, '--json'])).stdout)).toMatchObject({ status: 'ended', endReason: 'killed' });
    expect((await cli(['list', '-q'])).stdout).not.toContain(id);
    expect((await cli(['list', '--all', '-q'])).stdout).toContain(id);
  });

  it('streams command output and passes the exit code through', async () => {
    const id = await createSandbox();
    const ok = await cli(['exec', id, '--env', 'A=1', '--cwd', 'work', 'echo hello']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('ran: echo hello\ncwd: /home/fake/work\nenv: {"A":"1"}\n');
    expect(ok.stderr).toBe('warning\n');

    expect((await cli(['exec', id, 'exit 3'])).code).toBe(3);

    // Several arguments reach the command as separate arguments; options after the command belong to it.
    const argv = await cli(['exec', id, 'python3', '-c', 'print(6 * 7)', '--json']);
    expect(argv.stdout).toContain(`ran: python3 -c 'print(6 * 7)' --json\n`);
    expect((await cli(['exec', id, '--', 'ls', '-la'])).stdout).toContain('ran: ls -la\n');

    const asJson = await cli(['exec', id, '--json', 'exit 2']);
    expect(asJson.code).toBe(2);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ exitCode: 2, timedOut: false, stderr: 'warning\n' });

    const timedOut = await cli(['exec', id, '--timeout', '1', 'sleep']);
    expect(timedOut.code).toBe(124);
    expect(timedOut.stderr).toContain('timed out after 1s');

    expect((await cli(['exec', id, '--background', 'python3 -m http.server'])).code).toBe(0);
  });

  it('copies files and directories both ways', async () => {
    const id = await createSandbox();
    writeFileSync(join(dir, 'one.txt'), 'first file');
    mkdirSync(join(dir, 'app', 'src'), { recursive: true });
    writeFileSync(join(dir, 'app', 'main.py'), 'print(1)');
    writeFileSync(join(dir, 'app', 'src', 'lib.py'), Buffer.from([0, 1, 2, 255]));

    expect((await cli(['cp', 'one.txt', `${id}:docs/one.txt`])).code).toBe(0);
    expect((await cli(['cp', 'one.txt', `${id}:inbox/`])).code).toBe(0);
    const up = await cli(['cp', '-r', 'app', `${id}:project`]);
    expect(up.code, up.stderr).toBe(0);
    expect(up.stderr).toContain('Copied 2 files');
    expect((await cli(['cp', '-', `${id}:from-stdin.txt`], { input: 'piped in' })).code).toBe(0);

    const files = [...provider.sandboxes.values()].find((s) => s.sandboxId === id)!.files;
    expect([...files.keys()].sort()).toEqual([
      '/home/fake/docs/one.txt',
      '/home/fake/from-stdin.txt',
      '/home/fake/inbox/one.txt',
      '/home/fake/project/main.py',
      '/home/fake/project/src/lib.py',
    ]);

    const toStdout = await cli(['cp', `${id}:from-stdin.txt`, '-']);
    expect(toStdout.stdout).toBe('piped in');

    mkdirSync(join(dir, 'out'));
    expect((await cli(['cp', `${id}:docs/one.txt`, 'out'])).code).toBe(0);
    expect(readFileSync(join(dir, 'out', 'one.txt'), 'utf8')).toBe('first file');

    const down = await cli(['cp', '-r', `${id}:/home/fake/project`, 'copy']);
    expect(down.code, down.stderr).toBe(0);
    expect(readFileSync(join(dir, 'copy', 'main.py'), 'utf8')).toBe('print(1)');
    expect([...readFileSync(join(dir, 'copy', 'src', 'lib.py'))]).toEqual([0, 1, 2, 255]);

    const notDir = await cli(['cp', 'app', `${id}:x`]);
    expect(notDir.code).toBe(2);
    expect(notDir.stderr).toContain('use -r');
    const missing = await cli(['cp', `${id}:nope.txt`, 'nope.txt']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/error: .*nope/);
  });

  it('explains errors', async () => {
    const notFound = await cli(['get', 'sbx_doesnotexist']);
    expect(notFound.code).toBe(1);
    expect(notFound.stderr).toMatch(/^error: .*not found/i);

    const asJson = await cli(['get', 'sbx_doesnotexist', '--json']);
    expect(JSON.parse(asJson.stderr)).toMatchObject({ error: { code: 'not_found', status: 404 } });

    const usage = await cli(['create', '--sise', 'small']);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("Unknown option '--sise'");
    expect(usage.stderr).toContain("sandboxrouter create --help");

    expect((await cli(['craete'])).stderr).toContain('Did you mean "create"?');
    expect((await cli(['exec', 'sbx_x'])).stderr).toContain('Missing <command>');
    expect((await cli(['timeout', 'sbx_x', 'soon'])).stderr).toContain('duration like 90s');
  });

  it('shows providers and help without a sandbox', async () => {
    const providers = await cli(['providers']);
    expect(providers.code).toBe(0);
    expect(providers.stdout).toMatch(/^PROVIDER +SMALL/);
    expect(providers.stdout).toContain('e2b');
    for (const command of ['login', 'create', 'list', 'get', 'exec', 'cp', 'url', 'timeout', 'kill', 'providers', 'status', 'logout']) {
      const help = await cli([command, '--help']);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain(`Usage: sandboxrouter ${command}`);
    }
    expect((await cli(['--version'])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
