import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  NotEnoughSpaceError,
  RateLimitError,
  Sandbox,
  SandboxError,
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxUnreachableError,
  ServiceBusyError,
  TimeoutError,
} from 'e2b';
import { ProviderError, errorMessage } from './errors.ts';
import { type PriceSheet, ratePerHour } from './pricing.ts';
import {
  SANDBOX_ID_LABEL,
  SIZE_SPECS,
  type CreatedSandbox,
  type FileEntry,
  type Provider,
  type Resources,
  type SandboxRef,
  type Size,
  type TaggedSandbox,
} from './types.ts';

/**
 * E2B sets vCPU and RAM per template, so each size is a template built from E2B's
 * `base` image with that size (see scripts/build-e2b-templates.ts).
 */
export const E2B_TEMPLATES: Record<Size, string> = {
  small: 'sandboxrouter-small',
  medium: 'sandboxrouter-medium',
  large: 'sandboxrouter-large',
};

// https://e2b.dev/pricing: $0.000014 per vCPU-second, $0.0000045 per GiB-second, disk free.
const PRICES: PriceSheet = {
  cpuPerHour: 50_400,
  memoryGibPerHour: 16_200,
  diskGibPerHour: 0,
  freeDiskGib: 0,
};

// The `base` image runs as `user` in /home/user (https://docs.e2b.dev/template/user-and-workdir).
const HOME_DIR = '/home/user';
/**
 * Extra lifetime given to E2B's own deadline so it never fires before ours (E2B counts from
 * its own start; ours is exact). We kill the sandbox at our deadline.
 */
const DEADLINE_MARGIN_SECONDS = 60;

export interface E2BConfig {
  apiKey: string;
  /** 3600 on the Hobby plan, 86400 on Pro (https://docs.e2b.dev/billing). */
  maxLifetimeSeconds: number;
}

export function createE2BProvider(config: E2BConfig): Provider {
  const api = { apiKey: config.apiKey };

  const fail = (error: unknown, context: string): never => {
    throw toProviderError(error, context);
  };

  /**
   * Connecting to a running sandbox only ever extends its timeout to
   * max(current, now + timeoutMs). Passing the time left until our deadline keeps
   * the provider deadline exactly where we set it.
   */
  const connect = async (ref: SandboxRef) => {
    const timeoutMs = Math.max(1_000, ref.expiresAt.getTime() - Date.now());
    try {
      return await Sandbox.connect(ref.providerSandboxId, { ...api, timeoutMs });
    } catch (error) {
      return fail(error, 'connect');
    }
  };

  return {
    name: 'e2b',
    maxLifetimeSeconds: config.maxLifetimeSeconds,

    resources: (size) => ({ ...SIZE_SPECS[size], diskMib: null }),

    ratePerHourMicros: (resources: Resources) => ratePerHour(PRICES, resources),

    async create({ size, timeoutSeconds, sandboxId }): Promise<CreatedSandbox> {
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.create(E2B_TEMPLATES[size], {
          ...api,
          // Fail fast on limits so the router can move on to the next provider.
          retries: 0,
          idempotencyKey: sandboxId.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
          timeoutMs: Math.min(timeoutSeconds + DEADLINE_MARGIN_SECONDS, config.maxLifetimeSeconds) * 1000,
          metadata: { [SANDBOX_ID_LABEL]: sandboxId },
          allowInternetAccess: true,
          // Port URLs are reachable without a header; envd itself stays token-protected.
          network: { allowPublicTraffic: true },
          lifecycle: { onTimeout: 'kill' },
        });
      } catch (error) {
        return fail(error, 'create');
      }
      try {
        const info = await sandbox.getInfo();
        return {
          providerSandboxId: sandbox.sandboxId,
          cpu: info.cpuCount,
          memoryMib: info.memoryMB,
          diskMib: null,
          homeDir: HOME_DIR,
          startedAt: info.startedAt,
        };
      } catch (error) {
        // Don't leave a sandbox running that we can't price.
        await Sandbox.kill(sandbox.sandboxId, api).catch(() => {});
        return fail(error, 'create');
      }
    },

    async kill(providerSandboxId) {
      try {
        // Resolves false when the sandbox is already gone.
        await Sandbox.kill(providerSandboxId, api);
      } catch (error) {
        const mapped = toProviderError(error, 'kill');
        if (mapped.code !== 'sandbox_not_found') throw mapped;
      }
    },

    async setTimeout(ref) {
      const timeoutMs = Math.max(1_000, ref.expiresAt.getTime() - Date.now());
      try {
        await Sandbox.setTimeout(ref.providerSandboxId, timeoutMs, api);
      } catch (error) {
        fail(error, 'set timeout');
      }
    },

    async listTagged(): Promise<TaggedSandbox[]> {
      const result: TaggedSandbox[] = [];
      try {
        const paginator = Sandbox.list({ ...api, limit: 100 });
        while (paginator.hasNext) {
          for (const info of await paginator.nextItems()) {
            const sandboxId = info.metadata[SANDBOX_ID_LABEL];
            if (sandboxId) result.push({ providerSandboxId: info.sandboxId, sandboxId });
          }
        }
      } catch (error) {
        fail(error, 'list');
      }
      return result;
    },

    async isAlive(providerSandboxId) {
      try {
        const info = await Sandbox.getInfo(providerSandboxId, api);
        return info.state === 'running';
      } catch (error) {
        const mapped = toProviderError(error, 'get info');
        if (mapped.code === 'sandbox_not_found') return false;
        throw mapped;
      }
    },

    async exec(ref, request) {
      const sandbox = await connect(ref);
      if (request.signal.aborted) return { exitCode: null, timedOut: false };
      try {
        const handle = await sandbox.commands.run(request.command, {
          background: true,
          cwd: request.cwd,
          envs: request.env,
          timeoutMs: request.timeoutMs,
          onStdout: request.onStdout,
          onStderr: request.onStderr,
          retainOutput: false,
        });
        const onAbort = () => void handle.kill().catch(() => {});
        request.signal.addEventListener('abort', onAbort, { once: true });
        // The caller may have gone away while the command was starting.
        if (request.signal.aborted) onAbort();
        try {
          const result = await handle.wait();
          return { exitCode: result.exitCode, timedOut: false };
        } catch (error) {
          if (error instanceof CommandExitError) {
            return { exitCode: request.signal.aborted ? null : error.exitCode, timedOut: false };
          }
          // These two extend TimeoutError but mean the sandbox itself is gone or unreachable.
          if (error instanceof SandboxNotRunningError || error instanceof SandboxUnreachableError) throw error;
          if (error instanceof TimeoutError) return { exitCode: null, timedOut: true };
          throw error;
        } finally {
          request.signal.removeEventListener('abort', onAbort);
        }
      } catch (error) {
        return fail(error, 'exec');
      }
    },

    async startBackground(ref, request) {
      const sandbox = await connect(ref);
      try {
        const handle = await sandbox.commands.run(request.command, {
          background: true,
          cwd: request.cwd,
          envs: request.env,
          // 0 disables the command timeout; the process lives until the sandbox ends.
          timeoutMs: 0,
          retainOutput: false,
        });
        await handle.disconnect();
      } catch (error) {
        fail(error, 'start background command');
      }
    },

    async readFile(ref, path) {
      const sandbox = await connect(ref);
      try {
        return await sandbox.files.read(path, { format: 'stream' });
      } catch (error) {
        return fail(error, `read ${path}`);
      }
    },

    async writeFile(ref, path, data) {
      const sandbox = await connect(ref);
      try {
        await sandbox.files.write(path, data);
      } catch (error) {
        fail(error, `write ${path}`);
      }
    },

    async listFiles(ref, path): Promise<FileEntry[]> {
      const sandbox = await connect(ref);
      try {
        const entries = await sandbox.files.list(path);
        return entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type === 'dir' ? 'dir' : entry.type === 'symlink' ? 'symlink' : 'file',
          size: entry.size,
          modifiedAt: entry.modifiedTime?.toISOString() ?? null,
        }));
      } catch (error) {
        return fail(error, `list ${path}`);
      }
    },

    async removeFile(ref, path) {
      const sandbox = await connect(ref);
      try {
        await sandbox.files.remove(path);
      } catch (error) {
        fail(error, `remove ${path}`);
      }
    },

    async portUrl(ref, port) {
      const sandbox = await connect(ref);
      return { url: `https://${sandbox.getHost(port)}`, expiresAt: null };
    },
  };
}

function toProviderError(error: unknown, context: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = `E2B ${context} failed: ${errorMessage(error)}`;
  const code = (() => {
    // FileNotFoundError and SandboxNotFoundError share a parent class, so check files first.
    if (error instanceof FileNotFoundError) return 'file_not_found';
    if (error instanceof SandboxNotFoundError || error instanceof SandboxNotRunningError) return 'sandbox_not_found';
    if (error instanceof RateLimitError) return 'rate_limited';
    if (error instanceof NotEnoughSpaceError || error instanceof InvalidArgumentError) return 'invalid_request';
    if (error instanceof AuthenticationError || error instanceof ServiceBusyError || error instanceof TimeoutError) {
      return 'unavailable';
    }
    if (error instanceof SandboxError && error.statusCode !== undefined) {
      if (error.statusCode === 404) return 'sandbox_not_found';
      if (error.statusCode === 429) return 'rate_limited';
      if (error.statusCode >= 500) return 'unavailable';
      if (error.statusCode >= 400) return 'invalid_request';
    }
    return 'unknown';
  })();
  return new ProviderError('e2b', code, message, { cause: error });
}
