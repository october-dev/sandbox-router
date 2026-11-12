import { EventSourceParserStream } from 'eventsource-parser/stream';
import type {
  Account,
  CreateSandboxOptions,
  ExecEvent,
  ExecOptions,
  ExecResult,
  FileEntry,
  ListSandboxesOptions,
  PortUrl,
  ProviderInfo,
  SandboxData,
  SandboxPage,
} from './types.ts';

export type * from './types.ts';

export interface ClientOptions {
  /** Defaults to the SANDBOXROUTER_API_KEY environment variable. */
  apiKey?: string;
  /**
   * The server to talk to, e.g. `http://localhost:8787` for a self-hosted one.
   * Defaults to the SANDBOXROUTER_BASE_URL environment variable. There is no
   * built-in default, so an API key is never sent anywhere you didn't choose.
   */
  baseUrl?: string;
  /** Custom fetch, e.g. for proxies or tests. */
  fetch?: typeof fetch;
}

/** An error returned by the API, with its stable `code` and HTTP `status`. */
export class SandboxRouterError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SandboxRouterError';
    this.status = status;
    this.code = code;
  }
}

type RawBody = NonNullable<RequestInit['body']>;
type Body = RawBody | object | undefined;

class Transport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const apiKey = options.apiKey ?? env?.SANDBOXROUTER_API_KEY;
    if (!apiKey) throw new Error('Pass apiKey or set SANDBOXROUTER_API_KEY');
    this.apiKey = apiKey;
    const baseUrl = options.baseUrl ?? env?.SANDBOXROUTER_BASE_URL;
    if (!baseUrl) throw new Error('Pass baseUrl or set SANDBOXROUTER_BASE_URL, e.g. http://localhost:8787');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request(
    method: string,
    path: string,
    options: { query?: Record<string, string | number | undefined>; body?: Body; accept?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (options.accept) headers.accept = options.accept;
    let body: RawBody | undefined;
    if (isRawBody(options.body)) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const init: RequestInit & { duplex?: 'half' } = { method, headers, body, signal: options.signal };
    // Node's fetch requires half-duplex mode to send a streaming body.
    if (body instanceof ReadableStream) init.duplex = 'half';
    const response = await this.fetchImpl(url, init);
    if (!response.ok) throw await toError(response);
    return response;
  }

  async json<T>(method: string, path: string, options?: Parameters<Transport['request']>[2]): Promise<T> {
    return (await this.request(method, path, options)).json() as Promise<T>;
  }
}

function isRawBody(body: Body): body is RawBody {
  return (
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof Blob ||
    body instanceof ReadableStream
  );
}

async function toError(response: Response): Promise<SandboxRouterError> {
  const text = await response.text();
  try {
    const { error } = JSON.parse(text) as { error: { code: string; message: string } };
    return new SandboxRouterError(response.status, error.code, error.message);
  } catch {
    return new SandboxRouterError(response.status, 'http_error', text || response.statusText);
  }
}

export class SandboxRouter {
  private readonly transport: Transport;
  readonly sandboxes: Sandboxes;

  constructor(options: ClientOptions = {}) {
    this.transport = new Transport(options);
    this.sandboxes = new Sandboxes(this.transport);
  }

  /** Your balance and how much is reserved by running sandboxes. Cloud only: self-hosted servers have no balance and return 404. */
  account(): Promise<Account> {
    return this.transport.json('GET', '/v1/account');
  }

  /** Providers, their prices per size, and recent create latency. */
  async providers(): Promise<ProviderInfo[]> {
    return (await this.transport.json<{ data: ProviderInfo[] }>('GET', '/v1/providers')).data;
  }
}

export class Sandboxes {
  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** Creates a sandbox on the best provider for the preset and waits until it is running. */
  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    return new Sandbox(this.transport, await this.transport.json('POST', '/v1/sandboxes', { body: options }));
  }

  async get(id: string): Promise<Sandbox> {
    return new Sandbox(this.transport, await this.transport.json('GET', `/v1/sandboxes/${encodeURIComponent(id)}`));
  }

  /** One page, newest first. Pass `nextCursor` as `before` for the next page. */
  list(options: ListSandboxesOptions = {}): Promise<SandboxPage> {
    return this.transport.json('GET', '/v1/sandboxes', { query: { ...options } });
  }
}

export class Sandbox {
  private readonly transport: Transport;
  /** The latest known state. Updated by `refresh`, `setTimeout` and `kill`. */
  data: SandboxData;
  readonly files: Files;

  constructor(transport: Transport, data: SandboxData) {
    this.transport = transport;
    this.data = data;
    this.files = new Files(transport, this.path(''));
  }

  get id(): string {
    return this.data.id;
  }

  private path(suffix: string) {
    return `/v1/sandboxes/${encodeURIComponent(this.data.id)}${suffix}`;
  }

  async refresh(): Promise<SandboxData> {
    this.data = await this.transport.json('GET', this.path(''));
    return this.data;
  }

  /** Runs a command with `bash -lc` and returns its output once it exits. */
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const { signal, ...rest } = options;
    return this.transport.json('POST', this.path('/exec'), { body: { command, ...rest }, signal });
  }

  /** Runs a command and yields its output as it is produced, ending with an `exit` event. */
  async *execStream(command: string, options: ExecOptions = {}): AsyncGenerator<ExecEvent> {
    const { signal, ...rest } = options;
    const response = await this.transport.request('POST', this.path('/exec'), {
      body: { command, ...rest },
      accept: 'text/event-stream',
      signal,
    });
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const data = JSON.parse(value.data) as unknown;
        if (value.event === 'stdout' || value.event === 'stderr') {
          yield { type: value.event, data: data as string };
        } else if (value.event === 'exit') {
          yield { type: 'exit', ...(data as { exitCode: number | null; timedOut: boolean; durationMs: number }) };
        } else if (value.event === 'error') {
          const error = data as { code: string; message: string };
          throw new SandboxRouterError(502, error.code, error.message);
        }
      }
    } finally {
      // Stops reading; the server kills the command if it is still running.
      await reader.cancel().catch(() => {});
    }
  }

  /** Starts a command and returns immediately. Its output is discarded unless redirected. */
  async startBackground(command: string, options: Omit<ExecOptions, 'timeout' | 'signal'> = {}): Promise<void> {
    await this.transport.request('POST', this.path('/exec'), { body: { command, ...options, background: true } });
  }

  /** An HTTPS URL that reaches a server listening on `port` inside the sandbox. */
  portUrl(port: number): Promise<PortUrl> {
    return this.transport.json('GET', this.path(`/ports/${port}`));
  }

  /** Sets the sandbox to be killed `seconds` from now. */
  async setTimeout(seconds: number): Promise<SandboxData> {
    this.data = await this.transport.json('POST', this.path('/timeout'), { body: { timeout: seconds } });
    return this.data;
  }

  /** Kills the sandbox and returns its final state, including cost. */
  async kill(): Promise<SandboxData> {
    this.data = await this.transport.json('DELETE', this.path(''));
    return this.data;
  }
}

export class Files {
  private readonly transport: Transport;
  private readonly base: string;

  constructor(transport: Transport, base: string) {
    this.transport = transport;
    this.base = base;
  }

  /** Paths are absolute or relative to the sandbox's home directory. */
  async read(path: string): Promise<Uint8Array> {
    const response = await this.transport.request('GET', `${this.base}/files/content`, { query: { path } });
    return new Uint8Array(await response.arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  /** Creates parent directories and replaces any existing file. Up to 100 MiB. */
  async write(path: string, content: string | Uint8Array | Blob | ReadableStream<Uint8Array>): Promise<{ path: string }> {
    return this.transport.json('PUT', `${this.base}/files/content`, { query: { path }, body: content });
  }

  async list(path = '.'): Promise<FileEntry[]> {
    return (await this.transport.json<{ data: FileEntry[] }>('GET', `${this.base}/files`, { query: { path } })).data;
  }

  /** Removes a file, or a directory recursively. */
  async remove(path: string): Promise<void> {
    await this.transport.request('DELETE', `${this.base}/files`, { query: { path } });
  }
}
