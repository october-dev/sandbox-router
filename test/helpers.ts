import { randomUUID } from 'node:crypto';
import { accounts, createDb, type Db } from '@sr/db';
import type {
  CreatedSandbox,
  FileEntry,
  Provider,
  ProviderName,
  Resources,
  SandboxRef,
  Size,
  TaggedSandbox,
} from '@sr/providers';
import { ProviderError, SIZE_SPECS } from '@sr/providers';
import { sql } from 'drizzle-orm';

let shared: ReturnType<typeof createDb> | undefined;

export function testDb(): Db {
  shared ??= createDb(process.env.TEST_DATABASE_URL!, { max: 5 });
  return shared.db;
}

export async function closeTestDb() {
  await shared?.pool.end();
  shared = undefined;
}

export async function resetDb() {
  await testDb().execute(
    // Cascades to any tables that reference these, such as Cloud billing tables.
    sql`truncate table create_attempts, sandboxes, api_keys, accounts restart identity cascade`,
  );
}

export async function createAccount(): Promise<string> {
  const id = randomUUID();
  await testDb().insert(accounts).values({ id, email: `${id}@example.com` });
  return id;
}

export interface FakeSandbox {
  providerSandboxId: string;
  sandboxId: string;
  expiresAt: Date;
  files: Map<string, Uint8Array>;
}

/** An in-memory provider with controllable failures and prices. */
export class FakeProvider implements Provider {
  readonly name: ProviderName;
  maxLifetimeSeconds = 24 * 3600;
  cpuRate: number;
  createDelayMs = 0;
  /** Delays for setTimeout and kill calls, to simulate slow provider round trips. */
  setTimeoutDelayMs = 0;
  killDelayMs = 0;
  failCreate: Error | null = null;
  failKill: Error | null = null;
  /** Sandboxes missing from listings but still alive (a lagging list). */
  readonly hiddenFromList = new Set<string>();
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly killed: string[] = [];
  /** Commands that ended because their signal was aborted. */
  abortedCommands = 0;
  private counter = 0;

  constructor(name: ProviderName, options: { cpuRate?: number } = {}) {
    this.name = name;
    this.cpuRate = options.cpuRate ?? 50_000;
  }

  resources(size: Size): Resources {
    return { ...SIZE_SPECS[size], diskMib: null };
  }

  ratePerHourMicros(resources: Resources): number {
    return resources.cpu * this.cpuRate;
  }

  async create(input: { size: Size; timeoutSeconds: number; sandboxId: string }): Promise<CreatedSandbox> {
    // The provider "starts" the sandbox halfway through the create call.
    await sleep(this.createDelayMs / 2);
    const startedAt = new Date();
    await sleep(this.createDelayMs / 2);
    if (this.failCreate) throw this.failCreate;
    const providerSandboxId = `${this.name}-${++this.counter}`;
    this.sandboxes.set(providerSandboxId, {
      providerSandboxId,
      sandboxId: input.sandboxId,
      expiresAt: new Date(startedAt.getTime() + input.timeoutSeconds * 1000),
      files: new Map(),
    });
    return { providerSandboxId, ...this.resources(input.size), homeDir: '/home/fake', startedAt };
  }

  async kill(providerSandboxId: string) {
    await sleep(this.killDelayMs);
    if (this.failKill) throw this.failKill;
    this.killed.push(providerSandboxId);
    this.sandboxes.delete(providerSandboxId);
  }

  async setTimeout(ref: SandboxRef) {
    await sleep(this.setTimeoutDelayMs);
    this.get(ref).expiresAt = ref.expiresAt;
  }

  async listTagged(): Promise<TaggedSandbox[]> {
    return [...this.sandboxes.values()]
      .filter((s) => !this.hiddenFromList.has(s.providerSandboxId))
      .map((s) => ({ providerSandboxId: s.providerSandboxId, sandboxId: s.sandboxId }));
  }

  async isAlive(providerSandboxId: string) {
    return this.sandboxes.has(providerSandboxId);
  }

  async exec(ref: SandboxRef, request: Parameters<Provider['exec']>[1]) {
    this.get(ref);
    if (request.command === 'sleep') {
      // Like the real adapters: an already-aborted signal stops the command immediately.
      if (request.signal.aborted) {
        this.abortedCommands++;
        return { exitCode: null, timedOut: false };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, request.timeoutMs);
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (request.signal.aborted) this.abortedCommands++;
      return { exitCode: null, timedOut: !request.signal.aborted };
    }
    request.onStdout(`ran: ${request.command}\n`);
    request.onStdout(`cwd: ${request.cwd}\n`);
    if (Object.keys(request.env).length) request.onStdout(`env: ${JSON.stringify(request.env)}\n`);
    request.onStderr('warning\n');
    return { exitCode: request.command.startsWith('exit ') ? Number(request.command.slice(5)) : 0, timedOut: false };
  }

  async startBackground(ref: SandboxRef) {
    this.get(ref);
  }

  async readFile(ref: SandboxRef, path: string) {
    const data = this.get(ref).files.get(path);
    if (!data) throw new ProviderError(this.name, 'file_not_found', `no ${path}`);
    return new Response(data).body!;
  }

  async writeFile(ref: SandboxRef, path: string, data: ReadableStream<Uint8Array>) {
    this.get(ref).files.set(path, new Uint8Array(await new Response(data).arrayBuffer()));
  }

  async listFiles(ref: SandboxRef, path: string): Promise<FileEntry[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return [...this.get(ref).files.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, d]) => ({ name: p.slice(prefix.length), path: p, type: 'file', size: d.length, modifiedAt: null }));
  }

  async removeFile(ref: SandboxRef, path: string) {
    this.get(ref).files.delete(path);
  }

  async portUrl(ref: SandboxRef, port: number) {
    return { url: `https://${port}-${ref.providerSandboxId}.fake.test`, expiresAt: null };
  }

  private get(ref: SandboxRef): FakeSandbox {
    const sandbox = this.sandboxes.get(ref.providerSandboxId);
    if (!sandbox) throw new ProviderError(this.name, 'sandbox_not_found', 'gone');
    return sandbox;
  }
}

function sleep(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
