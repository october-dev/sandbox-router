import {
  AuthenticationError,
  type CommandHandle,
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  NotEnoughSpaceError,
  NotFoundError,
  RateLimitError,
  Sandbox,
  SandboxError,
  SandboxNotFoundError,
  TimeoutError,
} from 'novita-sandbox';
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
 * Novita (an E2B fork) sets vCPU and RAM per template, so each size is a template built from
 * Novita's base image with that size (see scripts/build-novita-templates.ts).
 */
export const NOVITA_TEMPLATES: Record<Size, string> = {
  small: 'sandboxrouter-small',
  medium: 'sandboxrouter-medium',
  large: 'sandboxrouter-large',
};

/** The SDK's own default; pinned here so a NOVITA_DOMAIN in the environment can't move us. */
export const NOVITA_DEFAULT_DOMAIN = 'us-phx-1.sandbox.novita.ai';

// https://docs.novita.ai/guides/sandbox-pricing.md: $0.0000098 per vCPU-second,
// $0.0000032 per GiB-second, the 20 GB ephemeral disk is free.
const PRICES: PriceSheet = {
  cpuPerHour: 35_280,
  memoryGibPerHour: 11_520,
  diskGibPerHour: 0,
  freeDiskGib: 0,
};

// The SDK's default user is `user`; home is /home/user as on E2B.
// Confirm in the live smoke test (`echo $HOME` in a size template).
const HOME_DIR = '/home/user';
/**
 * Extra lifetime given to Novita's own deadline so it never fires before ours (Novita counts
 * from its own start; ours is exact). We kill the sandbox at our deadline.
 */
const DEADLINE_MARGIN_SECONDS = 60;
/** A file read fails when Novita sends nothing for this long. */
const STREAM_IDLE_TIMEOUT_MS = 60_000;
/** Upper bound on one file upload (the server caps uploads at 100 MiB). */
const WRITE_TIMEOUT_MS = 10 * 60_000;

export interface NovitaConfig {
  apiKey: string;
  /**
   * 3600 on Free, 10800 on Paid, 14400 on Enterprise
   * (https://docs.novita.ai/guides/sandbox-faq-max-runtime.md). Novita clamps longer timeouts.
   */
  maxLifetimeSeconds: number;
  /** Defaults to NOVITA_DEFAULT_DOMAIN. Legacy domains (sandbox.novita.ai) can't build templates. */
  domain?: string;
  /** Template names or ids per size, when they differ from NOVITA_TEMPLATES. */
  templates?: Partial<Record<Size, string>>;
}

export function createNovitaProvider(config: NovitaConfig): Provider {
  const api = { apiKey: config.apiKey, domain: config.domain ?? NOVITA_DEFAULT_DOMAIN };
  const templates: Record<Size, string> = { ...NOVITA_TEMPLATES, ...config.templates };

  const fail = (error: unknown, context: string): never => {
    throw toProviderError(error, context);
  };

  /**
   * On E2B, connecting to a running sandbox only ever extends its timeout to
   * max(current, now + timeoutMs). Passing the time left until our deadline keeps
   * the provider deadline at or after ours either way: if Novita sets rather than extends,
   * it lands exactly on our deadline, where we kill the sandbox anyway.
   * Confirm in the live smoke test that connect doesn't shorten past our deadline.
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
    name: 'novita',
    maxLifetimeSeconds: config.maxLifetimeSeconds,
    // POST /sandboxes/{id}/timeout extends or shortens, up to the plan cap.
    canExtendTimeout: true,

    resources: (size) => ({ ...SIZE_SPECS[size], diskMib: null }),

    ratePerHourMicros: (resources: Resources) => ratePerHour(PRICES, resources),

    async create({ size, timeoutSeconds, sandboxId }): Promise<CreatedSandbox> {
      let sandbox: Sandbox;
      try {
        // Unlike e2b, novita-sandbox has no `retries` or `idempotencyKey` option; a create
        // that fails after the server accepted it can leave an orphan, which listTagged finds.
        // We don't set `long_running`, so the plan cap applies and maxLifetimeSeconds must match it.
        sandbox = await Sandbox.create(templates[size], {
          ...api,
          timeoutMs: Math.min(timeoutSeconds + DEADLINE_MARGIN_SECONDS, config.maxLifetimeSeconds) * 1000,
          metadata: { [SANDBOX_ID_LABEL]: sandboxId },
          allowInternetAccess: true,
          // Port URLs are reachable without the traffic token header; envd itself stays
          // token-protected (`secure` defaults to true). Confirm in the live smoke test that
          // a port URL answers without the E2B-Traffic-Access-Token header.
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
        // Ask for paused sandboxes explicitly rather than relying on the server's default filter.
        const paginator = Sandbox.list({ ...api, limit: 100, query: { state: ['running', 'paused'] } });
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
        // novita-sandbox has no `retainOutput` and keeps every byte of output on the handle
        // for the command's whole life; we clear it after each chunk so a long, chatty command
        // can't grow our memory without bound. It also calls the callbacks without awaiting
        // them, so a rejected callback would be an unhandled rejection: swallow it here.
        let handle: CommandHandle | undefined;
        const forward = (callback: (chunk: string) => void | Promise<void>) => (chunk: string) => {
          if (handle) dropRetainedOutput(handle);
          try {
            void Promise.resolve(callback(chunk)).catch(() => {});
          } catch {
            // A throwing callback must not break the SDK's event loop.
          }
        };
        // The SDK runs every command as `/bin/bash -l -c <command>`.
        handle = await sandbox.commands.run(request.command, {
          background: true,
          cwd: request.cwd,
          envs: request.env,
          timeoutMs: request.timeoutMs,
          onStdout: forward(request.onStdout),
          onStderr: forward(request.onStderr),
        });
        const started = handle;
        dropRetainedOutput(started);
        const onAbort = () => void started.kill().catch(() => {});
        request.signal.addEventListener('abort', onAbort, { once: true });
        // The caller may have gone away while the command was starting.
        if (request.signal.aborted) onAbort();
        try {
          const result = await started.wait();
          return { exitCode: result.exitCode, timedOut: false };
        } catch (error) {
          if (error instanceof CommandExitError) {
            return { exitCode: request.signal.aborted ? null : error.exitCode, timedOut: false };
          }
          // novita-sandbox has no SandboxNotRunningError: a sandbox that went away surfaces as
          // a TimeoutError too, so only a command deadline counts as the command timing out.
          if (error instanceof TimeoutError && isCommandDeadline(error)) {
            // The deadline is the client stream's; make sure the process doesn't outlive it.
            await started.kill().catch(() => {});
            return { exitCode: null, timedOut: true };
          }
          // The output stream broke (or an output callback threw): the process may still be
          // running, with nobody left to read it or stop it at its deadline.
          await handle.kill().catch(() => {});
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
        });
        await handle.disconnect();
      } catch (error) {
        fail(error, 'start background command');
      }
    },

    async readFile(ref, path) {
      const sandbox = await connect(ref);
      try {
        // The SDK puts a total (not idle) request timeout on the whole download, which would
        // cut off any read that takes longer; we disable it and apply an idle timeout instead.
        const data: unknown = await sandbox.files.read(path, { format: 'stream', requestTimeoutMs: 0 });
        // For an empty file the SDK returns '' rather than a stream.
        if (!(data instanceof ReadableStream)) return new Blob([]).stream();
        return withIdleTimeout(data as ReadableStream<Uint8Array>, STREAM_IDLE_TIMEOUT_MS, path);
      } catch (error) {
        return fail(error, `read ${path}`);
      }
    },

    async writeFile(ref, path, data) {
      const sandbox = await connect(ref);
      try {
        // Creates parent directories and overwrites, as on E2B.
        // The SDK buffers the body, then uploads it under one total request timeout (60s by
        // default), too short for a large upload on a slow link.
        await sandbox.files.write(path, data, { requestTimeoutMs: WRITE_TIMEOUT_MS });
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
          // Novita's FileType has only file and dir; symlinks are told apart by their target.
          type: entry.symlinkTarget ? 'symlink' : entry.type === 'dir' ? 'dir' : 'file',
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
        // Recursive for directories on E2B. Confirm in the live smoke test on Novita.
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

/** novita-sandbox has no `retainOutput`; clear the output it accumulates on the handle. */
function dropRetainedOutput(handle: CommandHandle): void {
  const retained = handle as unknown as { _stdout?: unknown; _stderr?: unknown };
  if (typeof retained._stdout === 'string') retained._stdout = '';
  if (typeof retained._stderr === 'string') retained._stderr = '';
}

/**
 * Errors the stream when the source produces nothing for `idleMs` while we wait on it. Time
 * spent waiting on a slow consumer doesn't count, since we only read when asked to.
 */
function withIdleTimeout(source: ReadableStream<Uint8Array>, idleMs: number, path: string): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Novita read ${path} stalled for ${idleMs}ms`)), idleMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), idle]);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * The SDK maps envd's DeadlineExceeded (the command's `timeoutMs`) and Unavailable (the
 * sandbox is gone) both to TimeoutError; only the message tells them apart.
 */
function isCommandDeadline(error: TimeoutError): boolean {
  return error.message.includes("exceeding 'timeoutMs'");
}

/** The SDK reports API failures it has no class for as `SandboxError("<status>: <message>")`. */
function statusOf(error: SandboxError): number | null {
  const match = /^(\d{3}): /.exec(error.message);
  return match ? Number(match[1]) : null;
}

function toProviderError(error: unknown, context: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = `Novita ${context} failed: ${errorMessage(error)}`;
  const code = (() => {
    // FileNotFoundError and SandboxNotFoundError share a parent class, so check files first.
    if (error instanceof FileNotFoundError) return 'file_not_found';
    if (error instanceof SandboxNotFoundError) return 'sandbox_not_found';
    // Plain NotFoundError comes from envd (a missing path or process), not the sandbox API.
    if (error instanceof NotFoundError) return 'file_not_found';
    if (error instanceof RateLimitError) return 'rate_limited';
    if (error instanceof NotEnoughSpaceError || error instanceof InvalidArgumentError) return 'invalid_request';
    if (error instanceof TimeoutError) {
      // envd Unavailable: the sandbox stopped (what e2b calls SandboxNotRunningError).
      return error.message.includes('due to sandbox timeout') ? 'sandbox_not_found' : 'unavailable';
    }
    if (error instanceof AuthenticationError) return 'unavailable';
    if (error instanceof SandboxError) {
      const status = statusOf(error);
      if (status === null) return 'unknown';
      if (status === 404) return 'sandbox_not_found';
      // 402 is "insufficient balance": a quota the router should route around.
      // Concurrency-limit errors are expected as 429; confirm both codes in the live smoke test.
      if (status === 402 || status === 429) return 'rate_limited';
      if (status >= 500) return 'unavailable';
      if (status >= 400) return 'invalid_request';
    }
    return 'unknown';
  })();
  return new ProviderError('novita', code, message, { cause: error });
}
