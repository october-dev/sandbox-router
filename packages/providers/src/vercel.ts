import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { APIError, type Command, Sandbox, type SandboxRegion, StreamError } from '@vercel/sandbox';
import { ProviderError, type ProviderErrorCode, errorMessage } from './errors.ts';
import { type PriceSheet, ratePerHour } from './pricing.ts';
import { shellQuote } from './shell.ts';
import {
  SANDBOX_ID_LABEL,
  type CreatedSandbox,
  type ExecResult,
  type FileEntry,
  type Provider,
  type Resources,
  type SandboxRef,
  type Size,
  type TaggedSandbox,
} from './types.ts';

/**
 * Ports declared at creation. Vercel only routes ports listed when the sandbox is created
 * (at most 15), so these are the common dev-server ports (Next/Express, Vite, Python, generic).
 */
export const VERCEL_EXPOSED_PORTS = [3000, 5173, 8000, 8080];

/**
 * Vercel sets memory from vCPUs (2048 MB each; vCPUs are 1 or an even number), so only the
 * vCPU count is chosen. small gets 2 GiB, above the 1 GiB it asks for; medium and large match.
 */
const VCPUS: Record<Size, number> = { small: 1, medium: 2, large: 4 };
const MEMORY_MIB_PER_VCPU = 2048;
/** Every sandbox gets 64 GB of NVMe (docs, SDK >= 3.0); the API doesn't report it. */
const DISK_MIB = 64 * 1024;

/**
 * The default image, named explicitly: Ubuntu with bash, python3 (3.14, python-is-python3),
 * Node 24 and common tools (https://github.com/vercel/sandbox/tree/main/images).
 */
const IMAGE = 'vercel/sandbox/universal';
/** The image runs as `ubuntu` with HOME=/vercel; commands and relative paths default to /vercel/sandbox. */
const HOME_DIR = '/vercel';

// https://vercel.com/docs/sandbox/pricing (Pro/Ent list, iad1): $0.128 per vCPU-hour, $0.0212 per GB-hour
// of memory, disk free. CPU is billed only while active, so the full vCPU price is an upper bound.
const PRICES: PriceSheet = {
  cpuPerHour: 128_000,
  memoryGibPerHour: 21_200,
  diskGibPerHour: 0,
  freeDiskGib: 0,
};

/** Constant tag on all our sandboxes: list filtering matches one exact `key=value` only. */
const MARKER_TAG = 'sandboxrouter';
const MARKER_VALUE = '1';
/**
 * Extra lifetime on Vercel's own deadline so it never fires before ours (it counts from the
 * session start, which precedes the create call returning). We kill the sandbox at our deadline.
 */
const DEADLINE_MARGIN_SECONDS = 60;
/** The sandbox-side command timeout trails ours, so our own timer (which reports `timedOut`) fires first. */
const COMMAND_TIMEOUT_MARGIN_MS = 5_000;
/** Session states in which the VM exists and can run (or is about to). */
const ALIVE_STATES = new Set(['pending', 'running']);
/** Session states in which the sandbox is finished; anything else may still bill. */
const ENDED_STATES = new Set(['stopped', 'failed', 'aborted']);
/** Exit codes of the shell wrappers for listFiles and removeFile. */
const EXIT_MISSING = 3;
const EXIT_NOT_DIR = 4;

export interface VercelConfig {
  /** A Vercel access token (long-lived, unlike the 12-hour OIDC token from `vercel env pull`). */
  token: string;
  teamId: string;
  projectId: string;
  /** 2700 on Hobby (45 min), 86400 on Pro/Enterprise (https://vercel.com/docs/sandbox/pricing). */
  maxLifetimeSeconds: number;
  /** Region, e.g. "iad1" (the SDK default) or "fra1". */
  region?: string;
}

/** What a 404 means depends on the call: the sandbox for control-plane calls, a path for file calls. */
type NotFoundMeans = 'sandbox' | 'file' | 'other';

export function createVercelProvider(config: VercelConfig): Provider {
  // Always passed explicitly, so the SDK never falls back to OIDC or a device-auth flow.
  const creds = { token: config.token, teamId: config.teamId, projectId: config.projectId };

  /** Fetches the sandbox without resuming it, failing with `sandbox_not_found` if it is gone. */
  const fetch = async (providerSandboxId: string): Promise<Sandbox> => {
    try {
      return await Sandbox.get({ ...creds, name: providerSandboxId, resume: false });
    } catch (error) {
      throw toProviderError(error, 'get sandbox', 'sandbox');
    }
  };

  /**
   * Fetches a sandbox we're about to use. Any SDK call on a stopped sandbox silently boots a
   * new session, so a sandbox whose session has ended counts as gone and is never touched.
   */
  const connect = async (ref: SandboxRef): Promise<Sandbox> => {
    const sandbox = await fetch(ref.providerSandboxId);
    const status = statusOf(sandbox);
    if (!status || !ALIVE_STATES.has(status)) {
      throw new ProviderError('vercel', 'sandbox_not_found', `Vercel sandbox ${ref.providerSandboxId} is ${status ?? 'not running'}`);
    }
    return sandbox;
  };

  /** Operation failures don't say whether the VM went away, so a failure is checked against the control plane. */
  const failOperation = async (ref: SandboxRef, error: unknown, context: string, notFound: NotFoundMeans): Promise<never> => {
    const mapped = toProviderError(error, context, notFound);
    if (mapped.code === 'file_not_found' || mapped.code === 'rate_limited' || mapped.code === 'invalid_request') throw mapped;
    await connect(ref); // throws sandbox_not_found if it is gone
    throw mapped;
  };

  /** Runs a short shell script to completion and returns its exit code and stdout. */
  const run = async (sandbox: Sandbox, script: string) => {
    const result = await sandbox.runCommand({ cmd: 'bash', args: ['-c', script] });
    return { exitCode: result.exitCode, stdout: await result.stdout() };
  };

  return {
    name: 'vercel',
    maxLifetimeSeconds: config.maxLifetimeSeconds,
    canExtendTimeout: true,

    resources: (size) => ({ cpu: VCPUS[size], memoryMib: VCPUS[size] * MEMORY_MIB_PER_VCPU, diskMib: DISK_MIB }),

    ratePerHourMicros: (resources: Resources) => ratePerHour(PRICES, resources),

    async create({ size, timeoutSeconds, sandboxId }): Promise<CreatedSandbox> {
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.create({
          ...creds,
          // Names are unique per project, so a retried create can't make a second sandbox.
          name: `sr-${sandboxId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
          image: IMAGE,
          resources: { vcpus: VCPUS[size] },
          // Persistent is the default: stop/timeout would snapshot, and any later SDK call would
          // boot the sandbox again. Ours are ephemeral.
          persistent: false,
          timeout: Math.min(timeoutSeconds + DEADLINE_MARGIN_SECONDS, config.maxLifetimeSeconds) * 1000,
          ports: VERCEL_EXPOSED_PORTS,
          tags: { [MARKER_TAG]: MARKER_VALUE, [SANDBOX_ID_LABEL]: sandboxId },
          region: config.region as SandboxRegion | undefined,
        });
      } catch (error) {
        throw toProviderError(error, 'create', 'other');
      }
      // Not `await using`: disposing the sandbox would stop it.
      try {
        const session = sandbox.currentSession();
        const cpu = sandbox.vcpus ?? session.vcpus;
        return {
          providerSandboxId: sandbox.name,
          cpu,
          memoryMib: sandbox.memory ?? session.memory ?? cpu * MEMORY_MIB_PER_VCPU,
          diskMib: DISK_MIB,
          homeDir: HOME_DIR,
          startedAt: session.startedAt ?? sandbox.createdAt,
        };
      } catch (error) {
        // Don't leave a sandbox running that we can't price.
        await sandbox.delete().catch(() => {});
        throw toProviderError(error, 'create', 'other');
      }
    },

    async kill(providerSandboxId) {
      try {
        const sandbox = await Sandbox.get({ ...creds, name: providerSandboxId, resume: false });
        // Delete also stops a running session; a stopped record is deleted too so it can't linger.
        await sandbox.delete();
      } catch (error) {
        const mapped = toProviderError(error, 'kill', 'sandbox');
        if (mapped.code !== 'sandbox_not_found') throw mapped;
      }
    },

    async setTimeout(ref) {
      const sandbox = await connect(ref);
      // Vercel only documents extending (`extendTimeout` adds to the current deadline). Shortening
      // is unverified, so an earlier deadline is left alone: our lifecycle kills the sandbox at it.
      const target = ref.expiresAt.getTime() + DEADLINE_MARGIN_SECONDS * 1000;
      const current = sandbox.expiresAt?.getTime();
      if (current !== undefined && current >= target) return;
      // Without a reported deadline, extending from now overshoots, which is harmless.
      const durationMs = target - (current ?? Date.now());
      try {
        await sandbox.extendTimeout(Math.ceil(durationMs));
      } catch (error) {
        await failOperation(ref, error, 'set timeout', 'sandbox');
      }
    },

    async listTagged(): Promise<TaggedSandbox[]> {
      const result: TaggedSandbox[] = [];
      try {
        const sandboxes = await Sandbox.list({ ...creds, tags: { [MARKER_TAG]: MARKER_VALUE } });
        for await (const sandbox of sandboxes) {
          const sandboxId = sandbox.tags?.[SANDBOX_ID_LABEL];
          // Stopped records linger for days; `stopping` ones are kept so they get killed (deleted).
          if (sandboxId && !ENDED_STATES.has(sandbox.status)) {
            result.push({ providerSandboxId: sandbox.name, sandboxId });
          }
        }
      } catch (error) {
        throw toProviderError(error, 'list', 'other');
      }
      return result;
    },

    async isAlive(providerSandboxId) {
      try {
        const sandbox = await Sandbox.get({ ...creds, name: providerSandboxId, resume: false });
        const status = statusOf(sandbox);
        return status !== undefined && ALIVE_STATES.has(status);
      } catch (error) {
        const mapped = toProviderError(error, 'get sandbox', 'sandbox');
        if (mapped.code === 'sandbox_not_found') return false;
        throw mapped;
      }
    },

    async exec(ref, request): Promise<ExecResult> {
      const sandbox = await connect(ref);
      if (request.signal.aborted) return { exitCode: null, timedOut: false };
      // Ends our own log stream and wait when the command is stopped, even if the kill call fails.
      const local = new AbortController();
      let command: Command | null = null;
      let stopped: 'timeout' | 'abort' | null = null;
      const stop = (reason: 'timeout' | 'abort') => {
        if (stopped) return;
        stopped = reason;
        // Confirm in the live smoke test that killing `bash -lc` also ends its children.
        void command?.kill('SIGKILL').catch(() => {});
        local.abort();
      };
      const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
      const onAbort = () => stop('abort');
      request.signal.addEventListener('abort', onAbort, { once: true });
      try {
        // Detached, so the log stream can be consumed with backpressure on the callbacks.
        // The signal isn't passed: aborting the start request could leave a command running without a handle.
        command = await sandbox.runCommand({
          cmd: 'bash',
          args: ['-lc', request.command],
          cwd: request.cwd,
          env: request.env,
          detached: true,
          // Backstop in case our kill doesn't land; enforced inside the sandbox with SIGKILL.
          timeoutMs: request.timeoutMs + COMMAND_TIMEOUT_MARGIN_MS,
        });
        if (stopped) {
          void command.kill('SIGKILL').catch(() => {});
          return { exitCode: null, timedOut: stopped === 'timeout' };
        }
        try {
          for await (const line of command.logs({ signal: local.signal })) {
            if (line.stream === 'stdout') await request.onStdout(line.data);
            else if (line.stream === 'stderr') await request.onStderr(line.data);
          }
          if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
          // Confirm in the live smoke test that `wait` long-polls for commands that outlive one HTTP request.
          const finished = await command.wait({ signal: local.signal });
          if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
          return { exitCode: finished.exitCode, timedOut: false };
        } catch (error) {
          if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
          throw error;
        }
      } catch (error) {
        return failOperation(ref, error, 'exec', 'other');
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      }
    },

    async startBackground(ref, request) {
      const sandbox = await connect(ref);
      try {
        // Detached commands keep running after we return; no timeout, so it lives until the sandbox ends.
        await sandbox.runCommand({
          cmd: 'bash',
          args: ['-lc', request.command],
          cwd: request.cwd,
          env: request.env,
          detached: true,
        });
      } catch (error) {
        await failOperation(ref, error, 'start background command', 'other');
      }
    },

    async readFile(ref, path) {
      const sandbox = await connect(ref);
      let stream: NodeJS.ReadableStream | null;
      try {
        stream = await sandbox.readFile({ path });
      } catch (error) {
        return failOperation(ref, error, `read ${path}`, 'file');
      }
      // The SDK returns null rather than throwing when the file doesn't exist.
      if (stream === null) throw new ProviderError('vercel', 'file_not_found', `Vercel read ${path} failed: no such file`);
      return Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    },

    async writeFile(ref, path, data) {
      const sandbox = await connect(ref);
      try {
        // writeFiles takes whole buffers (it uploads a tarball), so the stream is collected first.
        const content = new Uint8Array(await new Response(data).arrayBuffer());
        // The tar extract probably creates parent directories, but that's unverified, so make them first.
        await sandbox.fs.mkdir(posix.dirname(path), { recursive: true });
        await sandbox.writeFiles([{ path, content }]);
      } catch (error) {
        await failOperation(ref, error, `write ${path}`, 'other');
      }
    },

    async listFiles(ref, path): Promise<FileEntry[]> {
      const sandbox = await connect(ref);
      // fs.readdir gives names and types only, so one find call gets sizes and times too.
      // NUL separators survive any file name.
      const p = shellQuote(path);
      const script =
        `[ -e ${p} ] || exit ${EXIT_MISSING}; [ -d ${p} ] || exit ${EXIT_NOT_DIR}; ` +
        `find ${p} -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0'`;
      let result: { exitCode: number; stdout: string };
      try {
        result = await run(sandbox, script);
      } catch (error) {
        return failOperation(ref, error, `list ${path}`, 'other');
      }
      if (result.exitCode === EXIT_MISSING) {
        throw new ProviderError('vercel', 'file_not_found', `Vercel list ${path} failed: no such directory`);
      }
      if (result.exitCode === EXIT_NOT_DIR) {
        throw new ProviderError('vercel', 'invalid_request', `Vercel list ${path} failed: not a directory`);
      }
      if (result.exitCode !== 0) {
        throw new ProviderError('vercel', 'invalid_request', `Vercel list ${path} failed with exit code ${result.exitCode}`);
      }
      const fields = result.stdout.split('\0');
      const entries: FileEntry[] = [];
      for (let i = 0; i + 3 < fields.length; i += 4) {
        const [name, kind, size, mtime] = fields.slice(i, i + 4) as [string, string, string, string];
        const seconds = Number(mtime);
        entries.push({
          name,
          path: joinPath(path, name),
          type: kind === 'd' ? 'dir' : kind === 'l' ? 'symlink' : 'file',
          size: Number(size) || 0,
          modifiedAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
        });
      }
      return entries;
    },

    async removeFile(ref, path) {
      const sandbox = await connect(ref);
      // fs.rm with force would hide a missing path, so the check is done here.
      const p = shellQuote(path);
      let result: { exitCode: number };
      try {
        result = await run(sandbox, `[ -e ${p} ] || [ -L ${p} ] || exit ${EXIT_MISSING}; rm -rf -- ${p}`);
      } catch (error) {
        return failOperation(ref, error, `remove ${path}`, 'other');
      }
      if (result.exitCode === EXIT_MISSING) {
        throw new ProviderError('vercel', 'file_not_found', `Vercel remove ${path} failed: no such file`);
      }
      if (result.exitCode !== 0) {
        throw new ProviderError('vercel', 'invalid_request', `Vercel remove ${path} failed with exit code ${result.exitCode}`);
      }
    },

    async portUrl(ref, port) {
      if (!VERCEL_EXPOSED_PORTS.includes(port)) {
        throw new ProviderError(
          'vercel',
          'invalid_request',
          `Vercel only exposes ports ${VERCEL_EXPOSED_PORTS.join(', ')}; port ${port} is not available`,
        );
      }
      const sandbox = await connect(ref);
      try {
        // The URL lasts as long as the session and needs no auth.
        return { url: sandbox.domain(port), expiresAt: null };
      } catch (error) {
        return failOperation(ref, error, `preview port ${port}`, 'other');
      }
    },
  };
}

/** The current session's status, or undefined when the sandbox has no session. */
function statusOf(sandbox: Sandbox): string | undefined {
  try {
    return sandbox.status;
  } catch {
    return undefined;
  }
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function toProviderError(error: unknown, context: string, notFound: NotFoundMeans): ProviderError {
  if (error instanceof ProviderError) return error;
  const detail = error instanceof APIError ? apiErrorDetail(error) : errorMessage(error);
  const message = `Vercel ${context} failed: ${detail}`;
  const code = ((): ProviderErrorCode => {
    if (error instanceof APIError) {
      const status = error.response.status;
      if (status === 404) {
        return notFound === 'sandbox' ? 'sandbox_not_found' : notFound === 'file' ? 'file_not_found' : 'unknown';
      }
      // The SDK already retried 429s. The code for an exhausted Hobby quota is unverified;
      // 402 is treated as a limit too (confirm in the live smoke test).
      if (status === 429 || status === 402) return 'rate_limited';
      if (status === 401 || status === 403) return 'unavailable';
      if (status >= 500) return 'unavailable';
      if (status >= 400) return 'invalid_request';
      return 'unknown';
    }
    // The stream broke, usually because the VM stopped; failOperation checks which.
    if (error instanceof StreamError) return 'unavailable';
    // fs helpers throw Node-style errors with a code.
    const fsCode = (error as { code?: unknown } | null)?.code;
    if (fsCode === 'ENOENT') return 'file_not_found';
    if (fsCode === 'EACCES' || fsCode === 'ENOTDIR' || fsCode === 'EISDIR') return 'invalid_request';
    // Network failures from fetch, or missing credentials.
    if (error instanceof TypeError || /credentials/i.test(errorMessage(error))) return 'unavailable';
    return 'unknown';
  })();
  return new ProviderError('vercel', code, message, { cause: error });
}

/** The SDK's message for an HTTP failure is often empty; the status and body say more. */
function apiErrorDetail(error: APIError<unknown>): string {
  const body = error.text ?? (error.json === undefined ? '' : JSON.stringify(error.json));
  return [`status ${error.response.status}`, error.message, body.slice(0, 500)].filter(Boolean).join(': ');
}
