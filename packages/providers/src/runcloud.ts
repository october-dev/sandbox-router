import { randomUUID } from 'node:crypto';
import { Client, RunCloudError, type Sandbox, type SandboxTunnel } from '@run-cloud/sdk';
import { ProviderError, type ProviderErrorCode, errorMessage } from './errors.ts';
import { type PriceSheet, ratePerHour } from './pricing.ts';
import { notAnOption, shellQuote } from './shell.ts';
import {
  SANDBOX_ID_LABEL,
  SIZE_SPECS,
  type CreatedSandbox,
  type ExecResult,
  type FileEntry,
  type Provider,
  type Resources,
  type TaggedSandbox,
} from './types.ts';

/**
 * https://run.cloud/pricing: $0.00000492 per physical core-second (one core is two vCPUs) and
 * $0.00000083175 per GiB-second of memory, billed per second. Disk is not billed separately.
 */
const PRICES: PriceSheet = {
  cpuPerHour: (0.00000492 / 2) * 3600 * 1_000_000,
  memoryGibPerHour: 0.00000083175 * 3600 * 1_000_000,
  diskGibPerHour: 0,
  freeDiskGib: 0,
};

const DEFAULT_IMAGE = 'runcloud/agent-base';
// The default image runs Ubuntu 24.04 as root.
const HOME_DIR = '/root';
/** run.cloud's ceiling for a sandbox's lifetime, counted from creation or the last timeout change. */
const MAX_LIFETIME_SECONDS = 24 * 3600;
/**
 * run.cloud counts the lifetime from its own create time, which precedes the running sandbox we
 * report by the boot time. This margin keeps its deadline after ours; we destroy the sandbox at
 * our deadline.
 */
const DEADLINE_MARGIN_SECONDS = 120;
/** Extra time the guest gets past our own exec timeout before it kills the command itself. */
const EXEC_BACKSTOP_SECONDS = 30;
const MIN_TUNNEL_TTL_SECONDS = 60;
const MAX_TUNNEL_TTL_SECONDS = 86_400;
/** A cached tunnel is reused only while it outlives what a new one would get, less this slack. */
const TUNNEL_REUSE_SLACK_MS = 60_000;
/** States in which a sandbox exists and can (or soon will) run commands. */
const LIVE_STATES = new Set(['pending', 'starting', 'running']);
/** States in which a sandbox still exists (and still holds resources until it is destroyed). */
const LISTED_STATES = ['pending', 'starting', 'running', 'paused'] as const;
/** Where exec keeps each command's process group id and cancel marker, inside the guest. */
const CONTROL_DIR = '/tmp/.sandboxrouter';
const EXIT_NOT_FOUND = 3;
const EXIT_NOT_A_DIRECTORY = 4;

export interface RunCloudConfig {
  apiKey: string;
  /** API base. The SDK default (https://api.run.cloud) is used when omitted. */
  apiUrl?: string;
  /** Region to place sandboxes in. run.cloud picks one when omitted. */
  region?: string;
  /** Image for every sandbox. Defaults to `runcloud/agent-base` (Ubuntu 24.04, bash, python3). */
  image?: string;
}

export function createRunCloudProvider(config: RunCloudConfig): Provider {
  const cloud = new Client({ apiKey: config.apiKey, ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}) });

  /**
   * Open tunnels by sandbox and port. run.cloud limits active tunnels per sandbox and account,
   * so a repeated portUrl reuses one instead of opening another.
   */
  const tunnels = new Map<string, Map<number, SandboxTunnel>>();

  const fail = (error: unknown, context: string): never => {
    throw toProviderError(error, context);
  };

  /** Runs a short script to completion (no streaming) and returns its result. */
  const sh = async (providerSandboxId: string, script: string, options: { cwd?: string; env?: Record<string, string> } = {}) => {
    const result = await cloud.sandboxes.execOnce(providerSandboxId, ['/bin/bash', '-c', script], {
      ...options,
      timeoutSeconds: 60,
    });
    return result;
  };

  /** Runs a script whose exit codes 3 and 4 mean "path not found" and "not a directory". */
  const pathScript = async (providerSandboxId: string, path: string, script: string, context: string) => {
    let result: Awaited<ReturnType<typeof sh>>;
    try {
      result = await sh(providerSandboxId, script);
    } catch (error) {
      return fail(error, context);
    }
    if (result.exitCode === EXIT_NOT_FOUND) {
      throw new ProviderError('runcloud', 'file_not_found', `runcloud ${context}: no such file or directory: ${path}`);
    }
    if (result.exitCode === EXIT_NOT_A_DIRECTORY) {
      throw new ProviderError('runcloud', 'invalid_request', `runcloud ${context}: not a directory: ${path}`);
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
      throw new ProviderError('runcloud', 'invalid_request', `runcloud ${context}: ${detail}`);
    }
    return result;
  };

  /**
   * Stops a command started by exec: kills its whole process group, or, when it hasn't
   * written its group id yet, leaves a marker that makes it exit before it runs.
   * The command writes its id before it checks the marker and we write the marker before we
   * read the id, so one of the two always sees the other.
   */
  const killCommand = (providerSandboxId: string, token: string) =>
    sh(
      providerSandboxId,
      `touch ${shellQuote(`${CONTROL_DIR}/${token}.cancel`)}; ` +
        `p=$(cat ${shellQuote(`${CONTROL_DIR}/${token}.pid`)} 2>/dev/null) && kill -KILL -- "-$p" 2>/dev/null; exit 0`,
    ).catch(() => {});

  return {
    name: 'runcloud',
    maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
    // setTimeout restarts the lifetime from now, so it can move either way.
    canExtendTimeout: true,

    // run.cloud takes any CPU and memory, so every size gets exactly its spec.
    resources: (size) => ({ ...SIZE_SPECS[size], diskMib: null }),

    ratePerHourMicros: (resources: Resources) => ratePerHour(PRICES, { ...resources, diskMib: null }),

    async create({ size, timeoutSeconds, sandboxId }): Promise<CreatedSandbox> {
      const spec = SIZE_SPECS[size];
      let sandbox: Sandbox;
      try {
        // Returns once the sandbox runs. A sandbox that fails to start is destroyed by the SDK.
        sandbox = await cloud.sandboxes.create({
          image: config.image ?? DEFAULT_IMAGE,
          cpu: spec.cpu,
          memory: spec.memoryMib,
          timeoutSeconds: Math.min(timeoutSeconds + DEADLINE_MARGIN_SECONDS, MAX_LIFETIME_SECONDS),
          // At the deadline, destroy it instead of parking a resumable snapshot for 48 hours.
          onTimeout: 'destroy',
          // Never pause an idle sandbox: our users expect it to be there until it is killed.
          idlePauseSeconds: 0,
          name: sandboxId,
          tags: { [SANDBOX_ID_LABEL]: sandboxId },
          // A retried create returns the same sandbox instead of a second billable one.
          idempotencyKey: sandboxId,
          ...(config.region ? { region: config.region } : {}),
        });
      } catch (error) {
        return fail(error, 'create');
      }
      return {
        providerSandboxId: sandbox.id,
        cpu: sandbox.milliCpu !== undefined ? sandbox.milliCpu / 1000 : spec.cpu,
        memoryMib: sandbox.memMb ?? spec.memoryMib,
        diskMib: null,
        homeDir: HOME_DIR,
        startedAt: sandbox.createdAt ? new Date(sandbox.createdAt) : null,
      };
    },

    async kill(providerSandboxId) {
      tunnels.delete(providerSandboxId);
      try {
        await cloud.sandboxes.destroy(providerSandboxId);
      } catch (error) {
        const mapped = toProviderError(error, 'kill');
        if (mapped.code === 'sandbox_not_found') return;
        throw mapped;
      }
    },

    async setTimeout(ref) {
      // The lifetime becomes now + seconds; rounding up never lands before ours.
      const seconds = Math.ceil((ref.expiresAt.getTime() - Date.now()) / 1000) + DEADLINE_MARGIN_SECONDS;
      try {
        await cloud.sandboxes.setTimeout(ref.providerSandboxId, Math.min(Math.max(60, seconds), MAX_LIFETIME_SECONDS));
      } catch (error) {
        fail(error, 'set timeout');
      }
    },

    async listTagged(): Promise<TaggedSandbox[]> {
      let sandboxes: Sandbox[];
      try {
        // Unfiltered, the list pages through every sandbox the account ever had, destroyed ones
        // included (minutes on a busy account), so ask for each undestroyed state instead.
        // The SDK has no tag filter, so the label is matched here.
        const pages = await Promise.all(LISTED_STATES.map((state) => cloud.sandboxes.list({ state })));
        sandboxes = pages.flat();
      } catch (error) {
        return fail(error, 'list');
      }
      const result = new Map<string, TaggedSandbox>();
      for (const sandbox of sandboxes) {
        const sandboxId = sandbox.tags?.[SANDBOX_ID_LABEL];
        if (sandboxId) result.set(sandbox.id, { providerSandboxId: sandbox.id, sandboxId });
      }
      return [...result.values()];
    },

    async isAlive(providerSandboxId) {
      try {
        const sandbox = await cloud.sandboxes.get(providerSandboxId);
        return LIVE_STATES.has(sandbox.state);
      } catch (error) {
        const mapped = toProviderError(error, 'get sandbox');
        if (mapped.code === 'sandbox_not_found') return false;
        throw mapped;
      }
    },

    async exec(ref, request): Promise<ExecResult> {
      if (request.signal.aborted) return { exitCode: null, timedOut: false };
      const id = ref.providerSandboxId;
      const token = randomUUID();
      const pidFile = shellQuote(`${CONTROL_DIR}/${token}.pid`);
      const cancelFile = shellQuote(`${CONTROL_DIR}/${token}.cancel`);
      // setsid gives the command its own process group, so a stop kills every process it started.
      // `bash -lc` gives the same login-bash semantics as the other providers.
      const argv = [
        'setsid',
        '-w',
        '/bin/bash',
        '-c',
        `mkdir -p ${CONTROL_DIR} && echo $$ > ${pidFile} && [ ! -e ${cancelFile} ] || exit 137; ` +
          `exec bash -lc ${shellQuote(request.command)}`,
      ];

      const stream = new AbortController();
      let killed = false;
      const killOnce = () => {
        if (killed) return;
        killed = true;
        void killCommand(id, token);
      };
      let stopped: 'timeout' | 'abort' | null = null;
      const stop = (reason: 'timeout' | 'abort') => {
        if (stopped || failure !== undefined) return;
        stopped = reason;
        stream.abort();
        killOnce();
      };
      /** An output callback threw: stop the command, which nobody is reading any more. */
      let failure: unknown;
      const halt = (error: unknown) => {
        if (stopped || failure !== undefined) return;
        failure = error;
        stream.abort();
        killOnce();
      };
      const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
      const onAbort = () => stop('abort');
      request.signal.addEventListener('abort', onAbort, { once: true });

      // The SDK's callbacks are synchronous, so output is handed on in order through a chain.
      let delivered: Promise<void> = Promise.resolve();
      const deliver = (sink: (chunk: string) => void | Promise<void>, text: string) => {
        if (text && failure === undefined) delivered = delivered.then(() => sink(text)).catch(halt);
      };
      const forward = (decoder: TextDecoder, sink: (chunk: string) => void | Promise<void>) => (chunk: Uint8Array) =>
        deliver(sink, decoder.decode(chunk, { stream: true }));
      const stdout = new TextDecoder();
      const stderr = new TextDecoder();
      try {
        // The SDK also keeps the whole output in memory until the command ends.
        const result = await cloud.sandboxes.exec(id, argv, {
          cwd: request.cwd,
          env: request.env,
          timeoutSeconds: Math.ceil(request.timeoutMs / 1000) + EXEC_BACKSTOP_SECONDS,
          signal: stream.signal,
          onStdout: forward(stdout, request.onStdout),
          onStderr: forward(stderr, request.onStderr),
        });
        deliver(request.onStdout, stdout.decode());
        deliver(request.onStderr, stderr.decode());
        await delivered;
        if (failure !== undefined) return fail(failure, 'exec');
        if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
        return { exitCode: result.exitCode, timedOut: false };
      } catch (error) {
        await delivered;
        if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
        // The output stream broke (or a callback threw): the command may still be running, with
        // nobody left to read it or stop it at its deadline.
        killOnce();
        return fail(failure ?? error, 'exec');
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      }
    },

    async startBackground(ref, request) {
      let result: Awaited<ReturnType<typeof sh>>;
      try {
        // Output goes to /dev/null so nothing holds the exec open; the process lives until it
        // exits or the sandbox ends.
        result = await sh(ref.providerSandboxId, `nohup setsid bash -lc ${shellQuote(request.command)} >/dev/null 2>&1 &`, {
          cwd: request.cwd,
          env: request.env,
        });
      } catch (error) {
        return fail(error, 'start background command');
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
        throw new ProviderError('runcloud', 'invalid_request', `runcloud start background command: ${detail}`);
      }
    },

    async readFile(ref, path) {
      try {
        const content = await cloud.sandboxes.readFile(ref.providerSandboxId, path);
        return new Response(content).body!;
      } catch (error) {
        return fail(error, `read ${path}`);
      }
    },

    async writeFile(ref, path, data) {
      const id = ref.providerSandboxId;
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      const content = new Uint8Array(await new Response(data).arrayBuffer());
      await pathScript(id, path, `mkdir -p -- ${shellQuote(dir)}`, `write ${path}`);
      try {
        await cloud.sandboxes.writeFile(id, path, content);
      } catch (error) {
        fail(error, `write ${path}`);
      }
    },

    async listFiles(ref, path): Promise<FileEntry[]> {
      const quoted = shellQuote(path);
      // One NUL-terminated field per value, so any file name survives.
      const { stdout } = await pathScript(
        ref.providerSandboxId,
        path,
        `[ -e ${quoted} ] || exit ${EXIT_NOT_FOUND}; [ -d ${quoted} ] || exit ${EXIT_NOT_A_DIRECTORY}; ` +
          // find has no `--`: a relative path starting with `-` would read as an expression.
          // -H lists the directory a symlinked path points to.
          `find -H ${shellQuote(notAnOption(path))} -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0%T@\\0'`,
        `list ${path}`,
      );
      const fields = stdout.split('\0');
      const entries: FileEntry[] = [];
      const base = path.endsWith('/') ? path : `${path}/`;
      for (let i = 0; i + 3 < fields.length; i += 4) {
        const [name, kind, size, mtime] = fields.slice(i, i + 4) as [string, string, string, string];
        const seconds = Number(mtime);
        entries.push({
          name,
          path: `${base}${name}`,
          type: kind === 'd' ? 'dir' : kind === 'l' ? 'symlink' : 'file',
          size: Number(size),
          modifiedAt: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
        });
      }
      return entries;
    },

    async removeFile(ref, path) {
      const quoted = shellQuote(path);
      await pathScript(
        ref.providerSandboxId,
        path,
        `[ -e ${quoted} ] || [ -L ${quoted} ] || exit ${EXIT_NOT_FOUND}; rm -rf -- ${quoted}`,
        `remove ${path}`,
      );
    },

    async portUrl(ref, port) {
      // A tunnel is a short-lived public URL; it lasts until our deadline, within run.cloud's bounds.
      const remaining = Math.ceil((ref.expiresAt.getTime() - Date.now()) / 1000);
      const ttlSeconds = Math.min(Math.max(MIN_TUNNEL_TTL_SECONDS, remaining), MAX_TUNNEL_TTL_SECONDS);
      const id = ref.providerSandboxId;
      const open = tunnels.get(id) ?? new Map<number, SandboxTunnel>();
      const cached = open.get(port);
      // Reuse it while it lasts as long as a new one would (e.g. until the sandbox's timeout was extended).
      if (cached && Date.parse(cached.expiresAt) >= Date.now() + ttlSeconds * 1000 - TUNNEL_REUSE_SLACK_MS) {
        return { url: cached.url, expiresAt: new Date(cached.expiresAt) };
      }
      let tunnel: SandboxTunnel;
      try {
        tunnel = await cloud.sandboxes.openTunnel(id, port, { ttlSeconds });
      } catch (error) {
        return fail(error, `open port ${port}`);
      }
      // Free the slot the old tunnel held (best effort; it also expires on its own).
      if (cached) void cloud.sandboxes.closeTunnel(id, cached.id).catch(() => {});
      open.set(port, tunnel);
      tunnels.set(id, open);
      return { url: tunnel.url, expiresAt: new Date(tunnel.expiresAt) };
    },
  };
}

export function toProviderError(error: unknown, context: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (!(error instanceof RunCloudError)) {
    // File reads and writes report a guest-side failure as a plain Error with its message.
    const message = errorMessage(error);
    const code: ProviderErrorCode = /no such file|not found|enoent/i.test(message)
      ? 'file_not_found'
      : /is a directory|not a directory|permission denied|no space left/i.test(message)
        ? 'invalid_request'
        : 'unknown';
    return new ProviderError('runcloud', code, `runcloud ${context} failed: ${message}`, { cause: error });
  }
  const status = error.status;
  const message = `runcloud ${context} failed: ${status}${error.code ? ` ${error.code}` : ''}: ${error.detail || error.message}`;
  const code = ((): ProviderErrorCode => {
    // 404 from the API, 4404 when an exec stream is refused for a missing sandbox.
    if (status === 404 || status === 410 || status === 4404) return 'sandbox_not_found';
    // Rate, concurrency and quota limits.
    if (status === 429) return 'rate_limited';
    // 409 sandbox_capacity_unavailable, 4409 not running (e.g. still starting), and other conflicts.
    if (status === 409 || status === 4409) return 'unavailable';
    // 401 bad key, 402 billing, 403 suspended or forbidden.
    if (status === 401 || status === 402 || status === 403) return 'unavailable';
    // 0: the request never got an answer (network, closed stream). 5xx: the platform failed.
    if (status === 0 || status >= 500) return 'unavailable';
    if (status >= 400 && status < 500) return 'invalid_request';
    return 'unknown';
  })();
  return new ProviderError('runcloud', code, message, { cause: error });
}
