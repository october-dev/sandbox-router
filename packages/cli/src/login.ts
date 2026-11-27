import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { SandboxRouter } from 'sandboxrouter';
import { CliError } from './args.ts';
import { info } from './output.ts';

export interface LoginResult {
  apiKey: string;
  /** How the key was obtained, for the summary line. */
  via: 'browser' | 'api_key' | 'admin_token';
  email?: string;
}

/** This machine's name, so keys the CLI creates are recognizable in key listings. */
function machineName(): string {
  return hostname().slice(0, 64) || 'unknown';
}

/**
 * Checks a pasted secret and turns it into an API key. API keys (`sr_...`) are checked
 * against the server; anything else is taken as a self-hosted server's ADMIN_TOKEN (which
 * can never start with `sr_`) and used once to create a key. The admin token is not stored.
 */
export async function keyFromSecret(baseUrl: string, secret: string, fetchImpl: typeof fetch): Promise<LoginResult> {
  if (secret.startsWith('sr_')) {
    // Any authenticated call proves the key works; listing one sandbox is the cheapest.
    await new SandboxRouter({ apiKey: secret, baseUrl, fetch: fetchImpl }).sandboxes.list({ limit: 1 });
    return { apiKey: secret, via: 'api_key' };
  }
  const response = await fetchImpl(`${baseUrl}/v1/api-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `CLI (${machineName()})` }),
  });
  if (response.status === 401) {
    throw new CliError('The server did not accept that key or admin token', 'API keys start with sr_. Check for missing characters.');
  }
  if (response.status === 403) {
    throw new CliError('That credential cannot create API keys', 'Paste an API key (sr_...) instead.');
  }
  if (!response.ok) throw new CliError(`Could not create an API key: HTTP ${response.status} ${await response.text()}`);
  const { key } = (await response.json()) as { key: string };
  return { apiKey: key, via: 'admin_token' };
}

interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

/**
 * Browser login (an OAuth-style device flow) on servers that offer it. Returns undefined
 * when the server has no such flow (self-hosted servers), so the caller can ask for a key.
 */
export async function browserLogin(
  baseUrl: string,
  options: { fetch: typeof fetch; openBrowser: boolean; sleep?: (ms: number) => Promise<void> },
): Promise<LoginResult | undefined> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = await postJson(options.fetch, `${baseUrl}/v1/cli/login`, { clientName: machineName() });
  if (started.status === 404 || started.status === 405) return undefined;
  if (started.status !== 200) throw new CliError(`Could not start browser login: ${describe(started)}`);
  const flow = started.body as DeviceStart;

  info(`To log in, open ${flow.verificationUrl} and enter the code: ${flow.userCode}`);
  if (options.openBrowser) openUrl(flow.verificationUrl);
  info('Waiting for you to approve in the browser...');

  let interval = Math.max(1, flow.interval) * 1000;
  const deadline = Date.now() + flow.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const polled = await postJson(options.fetch, `${baseUrl}/v1/cli/login/token`, { deviceCode: flow.deviceCode });
    if (polled.status === 200) {
      const body = polled.body as { apiKey: string; email?: string };
      return { apiKey: body.apiKey, via: 'browser', email: body.email };
    }
    const code = errorCode(polled.body);
    if (polled.status === 429) {
      interval = Math.max(interval, Number(polled.headers.get('retry-after') ?? 5) * 1000);
    } else if (code === 'slow_down') {
      interval += 2000;
    } else if (code === 'access_denied') {
      throw new CliError('Login was denied in the browser');
    } else if (code === 'expired_token') {
      throw new CliError('The login code expired', 'Run `sandboxrouter login` again.');
    } else if (code !== 'authorization_pending') {
      throw new CliError(`Login failed: ${describe(polled)}`);
    }
  }
  throw new CliError('The login code expired', 'Run `sandboxrouter login` again.');
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (e.g. a proxy's error page); kept as text for the message.
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}

function describe(result: { status: number; body: unknown }): string {
  const error = (result.body as { error?: { code?: string; message?: string } } | null)?.error;
  if (error?.message) return `${error.message} (${error.code})`;
  return `HTTP ${result.status}`;
}

function openUrl(url: string) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser available; the URL is printed above.
  }
}

/** Reads a line from the terminal without echoing it. */
export function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return done();
        if (char === '\u0003') return done(new CliError('Cancelled'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}
