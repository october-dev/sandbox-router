import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  Daytona,
  DaytonaAuthenticationError,
  DaytonaBadGatewayError,
  DaytonaBadRequestError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaFileNotFoundError,
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
  type Sandbox,
} from '@daytona/sdk';
import { ProviderError, type ProviderErrorCode, errorMessage } from './errors.ts';
import { type PriceSheet, ratePerHour } from './pricing.ts';
import { shellQuote } from './shell.ts';
import {
  SANDBOX_ID_LABEL,
  SIZE_SPECS,
  type CreatedSandbox,
  type ExecResult,
  type FileEntry,
  type Provider,
  type Resources,
  type SandboxRef,
  type Size,
  type TaggedSandbox,
} from './types.ts';

/** Daytona's default snapshots match our sizes (https://www.daytona.io/docs/en/snapshots). */
const SNAPSHOTS: Record<Size, { name: string; diskGib: number }> = {
  small: { name: 'daytona-small', diskGib: 3 },
  medium: { name: 'daytona-medium', diskGib: 8 },
  large: { name: 'daytona-large', diskGib: 10 },
};

// https://www.daytona.io/pricing: $0.0504/vCPU-h, $0.0162/GiB-h, $0.000108/GiB-h disk after 5 GiB.
const PRICES: PriceSheet = {
  cpuPerHour: 50_400,
  memoryGibPerHour: 16_200,
  diskGibPerHour: 108,
  freeDiskGib: 5,
};

/** We hold sandboxes to at most 24 hours; Daytona has no shorter cap by default. */
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
/** Signed preview URLs can live at most 24 hours. */
const MAX_PREVIEW_SECONDS = 24 * 60 * 60;
/** The create call may take up to this long (seconds). */
const CREATE_TIMEOUT_SECONDS = 120;
/**
 * `ttlMinutes` counts from Daytona's own creation time, which can precede the moment the
 * create call returns by up to the create timeout. This margin keeps Daytona's deadline
 * after ours; we kill the sandbox at our deadline.
 */
const TTL_MARGIN_MINUTES = Math.ceil(CREATE_TIMEOUT_SECONDS / 60);
/** States in which a sandbox is gone or going away. */
const GONE_STATES = new Set(['destroyed', 'destroying']);
/** States in which a sandbox exists but can't run anything. */
const BROKEN_STATES = new Set(['error', 'build_failed']);
/**
 * Every `Sandbox` object the SDK builds subscribes to state events for 5 minutes, and fetching
 * one costs a round trip, so live sandboxes are cached for about that long.
 */
const CACHE_TTL_MS = 4 * 60_000;
const CACHE_MAX = 1_000;

export interface DaytonaConfig {
  apiKey: string;
  /** Region, e.g. "us" or "eu". The organization default is used when omitted. */
  target?: string;
}

/** What a 404 means depends on the call: the sandbox for control-plane calls, a path for file calls. */
type NotFoundMeans = 'sandbox' | 'file' | 'other';

export function createDaytonaProvider(config: DaytonaConfig): Provider {
  const client = new Daytona({ apiKey: config.apiKey, target: config.target, requestTimeoutMs: 60_000 });
  const cache = new Map<string, { sandbox: Sandbox; at: number }>();

  const remember = (sandbox: Sandbox) => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(sandbox.id, { sandbox, at: Date.now() });
  };

  /** Fetches the sandbox, failing with `sandbox_not_found` if it no longer exists. */
  const get = async (providerSandboxId: string): Promise<Sandbox> => {
    const cached = cache.get(providerSandboxId);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.sandbox;
    let sandbox: Sandbox;
    try {
      sandbox = await client.get(providerSandboxId);
    } catch (error) {
      throw toProviderError(error, 'get sandbox', 'sandbox');
    }
    if (GONE_STATES.has(sandbox.state ?? '')) {
      throw new ProviderError('daytona', 'sandbox_not_found', `Daytona sandbox ${providerSandboxId} is ${sandbox.state}`);
    }
    remember(sandbox);
    return sandbox;
  };

  /**
   * Toolbox calls report a vanished sandbox as an ordinary error, so a failure is checked
   * against the control plane before it is reported.
   */
  const failOperation = async (providerSandboxId: string, error: unknown, context: string, notFound: NotFoundMeans): Promise<never> => {
    const mapped = toProviderError(error, context, notFound);
    if (mapped.code === 'file_not_found' || mapped.code === 'rate_limited') throw mapped;
    cache.delete(providerSandboxId);
    await get(providerSandboxId); // throws sandbox_not_found if it is gone
    throw mapped;
  };

  /**
   * Session commands run in the session's shell (zsh in the default snapshots).
   * Wrapping in `bash -lc` gives the same login-bash semantics as E2B.
   */
  const wrap = (command: string, cwd: string, env: Record<string, string>) => {
    const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
    return `cd ${shellQuote(cwd)} && env ${assignments.join(' ')} bash -lc ${shellQuote(command)}`;
  };

  return {
    name: 'daytona',
    maxLifetimeSeconds: MAX_LIFETIME_SECONDS,

    resources: (size) => ({ ...SIZE_SPECS[size], diskMib: SNAPSHOTS[size].diskGib * 1024 }),

    ratePerHourMicros: (resources: Resources) => ratePerHour(PRICES, resources),

    async create({ size, timeoutSeconds, sandboxId }): Promise<CreatedSandbox> {
      let sandbox: Sandbox;
      try {
        sandbox = await client.create(
          {
            snapshot: SNAPSHOTS[size].name,
            labels: { [SANDBOX_ID_LABEL]: sandboxId },
            // Delete as soon as the sandbox stops, and never stop it for inactivity:
            // it lives until we kill it or the TTL destroys it.
            ephemeral: true,
            autoStopInterval: 0,
            ttlMinutes: Math.ceil(timeoutSeconds / 60) + TTL_MARGIN_MINUTES,
            public: false,
          },
          { timeout: CREATE_TIMEOUT_SECONDS },
        );
      } catch (error) {
        // A create that times out may still have produced a sandbox that bills.
        if (error instanceof DaytonaTimeoutError && error.sandboxId) {
          await client.get(error.sandboxId).then(
            (s) => s.delete(),
            () => {},
          );
        }
        throw toProviderError(error, 'create', 'other');
      }
      try {
        const homeDir = (await sandbox.getUserHomeDir()) ?? '/home/daytona';
        remember(sandbox);
        return {
          providerSandboxId: sandbox.id,
          cpu: sandbox.cpu,
          memoryMib: sandbox.memory * 1024,
          diskMib: sandbox.disk * 1024,
          homeDir,
          startedAt: sandbox.createdAt ? new Date(sandbox.createdAt) : null,
        };
      } catch (error) {
        await sandbox.delete().catch(() => {});
        throw toProviderError(error, 'create', 'other');
      }
    },

    async kill(providerSandboxId) {
      cache.delete(providerSandboxId);
      try {
        const sandbox = await client.get(providerSandboxId);
        if (GONE_STATES.has(sandbox.state ?? '')) return;
        await sandbox.delete();
      } catch (error) {
        const mapped = toProviderError(error, 'kill', 'sandbox');
        if (mapped.code !== 'sandbox_not_found') throw mapped;
      }
    },

    async setTimeout(ref) {
      const sandbox = await get(ref.providerSandboxId);
      // setTtl counts from now, so rounding up to whole minutes never lands before our deadline.
      const minutes = Math.max(1, Math.ceil((ref.expiresAt.getTime() - Date.now()) / 60_000));
      try {
        await sandbox.setTtl(minutes);
      } catch (error) {
        throw toProviderError(error, 'set timeout', 'sandbox');
      }
    },

    async listTagged(): Promise<TaggedSandbox[]> {
      const result: TaggedSandbox[] = [];
      try {
        for await (const sandbox of client.list({ limit: 200 })) {
          const sandboxId = sandbox.labels[SANDBOX_ID_LABEL];
          if (sandboxId && !GONE_STATES.has(sandbox.state ?? '')) {
            result.push({ providerSandboxId: sandbox.id, sandboxId });
          }
        }
      } catch (error) {
        throw toProviderError(error, 'list', 'other');
      }
      return result;
    },

    async isAlive(providerSandboxId) {
      cache.delete(providerSandboxId);
      try {
        const sandbox = await client.get(providerSandboxId);
        const state = sandbox.state ?? '';
        return !GONE_STATES.has(state) && !BROKEN_STATES.has(state);
      } catch (error) {
        const mapped = toProviderError(error, 'get sandbox', 'sandbox');
        if (mapped.code === 'sandbox_not_found') return false;
        throw mapped;
      }
    },

    async exec(ref, request): Promise<ExecResult> {
      const sandbox = await get(ref.providerSandboxId);
      if (request.signal.aborted) return { exitCode: null, timedOut: false };
      const sessionId = `sr-${randomUUID()}`;
      const deadline = Date.now() + request.timeoutMs;
      let stopped: 'timeout' | 'abort' | null = null;
      // Deleting the session kills its process group, which also ends the log stream.
      const stop = (reason: 'timeout' | 'abort') => {
        if (stopped) return;
        stopped = reason;
        void sandbox.process.deleteSession(sessionId).catch(() => {});
      };
      const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
      const onAbort = () => stop('abort');
      request.signal.addEventListener('abort', onAbort, { once: true });
      // Track what has been delivered so output missed by a dropped stream can be sent later.
      let stdoutSent = 0;
      let stderrSent = 0;
      const onStdout = (chunk: string) => {
        stdoutSent += chunk.length;
        void request.onStdout(chunk);
      };
      const onStderr = (chunk: string) => {
        stderrSent += chunk.length;
        void request.onStderr(chunk);
      };
      try {
        await sandbox.process.createSession(sessionId);
        if (request.signal.aborted) stop('abort');
        if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
        const { cmdId } = await sandbox.process.executeSessionCommand(sessionId, {
          command: wrap(request.command, request.cwd, request.env),
          runAsync: true,
        });
        try {
          // Resolves when the command exits and the stream closes.
          await sandbox.process.getSessionCommandLogs(sessionId, cmdId, onStdout, onStderr);
        } catch (error) {
          if (!stopped) throw error;
        }
        // The stream can also close early; wait for the exit code until the deadline.
        let exitCode: number | undefined;
        let closedEarly = false;
        while (!stopped) {
          const command = await sandbox.process.getSessionCommand(sessionId, cmdId).catch((error: unknown) => {
            if (stopped) return null;
            throw error;
          });
          if (command?.exitCode !== undefined && command.exitCode !== null) {
            exitCode = command.exitCode;
            break;
          }
          closedEarly = true;
          if (Date.now() >= deadline) stop('timeout');
          else await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (stopped || exitCode === undefined) return { exitCode: null, timedOut: stopped === 'timeout' };

        if (closedEarly) {
          // The stream ended before the command did; deliver what it missed.
          const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
          if ((logs.stdout?.length ?? 0) > stdoutSent) await request.onStdout(logs.stdout!.slice(stdoutSent));
          if ((logs.stderr?.length ?? 0) > stderrSent) await request.onStderr(logs.stderr!.slice(stderrSent));
        }
        return { exitCode, timedOut: false };
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, 'exec', 'other');
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
        await sandbox.process.deleteSession(sessionId).catch(() => {});
      }
    },

    async startBackground(ref, request) {
      const sandbox = await get(ref.providerSandboxId);
      // The session is left open: deleting it would kill the process.
      const sessionId = `sr-bg-${randomUUID()}`;
      try {
        await sandbox.process.createSession(sessionId);
        await sandbox.process.executeSessionCommand(sessionId, {
          command: wrap(request.command, request.cwd, request.env),
          runAsync: true,
        });
      } catch (error) {
        await failOperation(ref.providerSandboxId, error, 'start background command', 'other');
      }
    },

    async readFile(ref, path) {
      const sandbox = await get(ref.providerSandboxId);
      try {
        const stream = await sandbox.fs.downloadFileStream(path);
        return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, `read ${path}`, 'file');
      }
    },

    async writeFile(ref, path, data) {
      const sandbox = await get(ref.providerSandboxId);
      try {
        await sandbox.fs.uploadFileStream(data, path);
      } catch (error) {
        await failOperation(ref.providerSandboxId, error, `write ${path}`, 'other');
      }
    },

    async listFiles(ref, path): Promise<FileEntry[]> {
      const sandbox = await get(ref.providerSandboxId);
      try {
        const entries = await sandbox.fs.listFiles(path);
        return entries.map((entry) => ({
          name: entry.name,
          path: entry.path ?? joinPath(path, entry.name),
          type: entry.isDir ? 'dir' : 'file',
          size: entry.size,
          modifiedAt: entry.modifiedAt || null,
        }));
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, `list ${path}`, 'file');
      }
    },

    async removeFile(ref, path) {
      const sandbox = await get(ref.providerSandboxId);
      try {
        await sandbox.fs.deleteFile(path, true);
      } catch (error) {
        await failOperation(ref.providerSandboxId, error, `remove ${path}`, 'file');
      }
    },

    async portUrl(ref, port) {
      const sandbox = await get(ref.providerSandboxId);
      const remaining = Math.ceil((ref.expiresAt.getTime() - Date.now()) / 1000);
      const seconds = Math.min(MAX_PREVIEW_SECONDS, Math.max(60, remaining));
      try {
        const signed = await sandbox.getSignedPreviewUrl(port, seconds);
        return { url: signed.url, expiresAt: new Date(Date.now() + seconds * 1000) };
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, `preview port ${port}`, 'other');
      }
    },
  };
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function toProviderError(error: unknown, context: string, notFound: NotFoundMeans): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = `Daytona ${context} failed: ${errorMessage(error)}`;
  const code = ((): ProviderErrorCode => {
    // DaytonaFileNotFoundError extends DaytonaNotFoundError, so check files first.
    if (error instanceof DaytonaFileNotFoundError) return 'file_not_found';
    if (error instanceof DaytonaNotFoundError) {
      return notFound === 'sandbox' ? 'sandbox_not_found' : notFound === 'file' ? 'file_not_found' : 'unknown';
    }
    if (error instanceof DaytonaRateLimitError) return 'rate_limited';
    if (error instanceof DaytonaBadRequestError) return 'invalid_request';
    if (
      error instanceof DaytonaAuthenticationError ||
      error instanceof DaytonaTimeoutError ||
      error instanceof DaytonaConnectionError ||
      error instanceof DaytonaServiceUnavailableError ||
      error instanceof DaytonaBadGatewayError ||
      error instanceof DaytonaInternalServerError
    ) {
      return 'unavailable';
    }
    if (error instanceof DaytonaError && error.statusCode !== undefined) {
      if (error.statusCode === 429) return 'rate_limited';
      if (error.statusCode >= 500) return 'unavailable';
      if (error.statusCode >= 400) return 'invalid_request';
    }
    return 'unknown';
  })();
  return new ProviderError('daytona', code, message, { cause: error });
}
