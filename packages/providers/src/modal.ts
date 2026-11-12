import { randomUUID } from 'node:crypto';
import {
  AlreadyExistsError,
  ClientClosedError,
  ConflictError,
  InvalidError,
  ModalClient,
  NotFoundError,
  ResourceExhaustedError,
  SandboxFilesystemError,
  SandboxFilesystemNotFoundError,
  SandboxTimeoutError,
  TimeoutError,
  type App,
  type ContainerProcess,
  type Image,
  type Sandbox,
  type SandboxRuntime,
} from 'modal';
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
  type ProviderName,
  type Resources,
  type SandboxRef,
  type Size,
  type TaggedSandbox,
} from './types.ts';

/**
 * Ports tunnelled at creation. Modal only exposes ports declared when the sandbox is
 * created, so `portUrl` works for these and no others.
 */
export const MODAL_EXPOSED_PORTS = [3000, 5173, 8000, 8080];

/**
 * Modal's `cpu` is physical cores and one core is two vCPUs
 * (https://modal.com/docs/guide/sandbox-resources), so each size asks for half its vCPU count.
 * The limits equal the requests: Modal bills max(request, usage), so bursting above the request
 * would cost more than the size's price.
 */
const MODAL_CPU_CORES: Record<Size, number> = {
  small: 0.5,
  medium: 1,
  large: 2,
};

// https://modal.com/pricing (sandbox, non-preemptible): $0.00003942 per physical core-second
// ($0.070956 per vCPU-hour at 2 vCPU per core) and $0.00000667 per GiB-second. No disk charge,
// and gVisor and VM are priced the same.
const PRICES: PriceSheet = {
  cpuPerHour: 70_956,
  memoryGibPerHour: 24_012,
  diskGibPerHour: 0,
  freeDiskGib: 0,
};

/** Modal caps sandbox lifetime at 24 hours on both runtimes. */
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
/**
 * Extra lifetime given to Modal's own deadline so it never fires before ours. Modal counts from
 * its own creation, which is after the moment we count from, so this only covers clock skew.
 */
const DEADLINE_MARGIN_SECONDS = 60;
/** The VM runtime has a fixed 512 GiB root filesystem; gVisor doesn't document its disk size. */
const VM_DISK_MIB = 512 * 1024;
/**
 * Debian slim with bash and python3 (plain `debian:*-slim` has no python3). It includes
 * util-linux, whose `setsid` exec relies on. Modal caches a registry tag as immutable after
 * the first build, so pin a specific tag.
 */
const DEFAULT_IMAGE = 'python:3.13-slim';
const DEFAULT_APP_NAME = 'sandboxrouter';
/** Records which runtime a sandbox runs on, so each provider lists only its own sandboxes. */
const RUNTIME_TAG = 'sandboxrouter_runtime';
const TUNNELS_TIMEOUT_MS = 30_000;
/** How long to wait for a killed command's exec to report its exit before giving up on it. */
const KILLED_EXEC_WAIT_MS = 10_000;
const LIST_TAGS_CONCURRENCY = 8;
/**
 * A `Sandbox` handle caches its task id and command-router connection, so reusing one saves
 * two round trips per call. Handles are dropped when the sandbox is killed or found gone.
 */
const HANDLE_CACHE_MAX = 500;

export interface ModalConfig {
  runtime: SandboxRuntime;
  /** Defaults to MODAL_TOKEN_ID / MODAL_TOKEN_SECRET or ~/.modal.toml, as the SDK reads them. */
  tokenId?: string;
  tokenSecret?: string;
  /** Modal environment; the profile's default when omitted. */
  environment?: string;
  /** The App all our sandboxes are created in. Defaults to "sandboxrouter". */
  appName?: string;
  /** Registry image tag. Defaults to python:3.13-slim. */
  image?: string;
  /** Lets both runtimes share one client (one gRPC connection); built from the fields above when omitted. */
  client?: ModalClient;
}

/**
 * What a not-found error means: the sandbox for every call made on one, something else
 * (App, image, environment) during create. Missing paths have their own error class.
 */
type NotFoundMeans = 'sandbox' | 'other';

export function createModalProvider(config: ModalConfig): Provider {
  const name: ProviderName = config.runtime === 'vm' ? 'modal-vm' : 'modal-gvisor';
  const label = config.runtime === 'vm' ? 'Modal VM' : 'Modal gVisor';
  const modal =
    config.client ??
    new ModalClient({ tokenId: config.tokenId, tokenSecret: config.tokenSecret, environment: config.environment });
  const appName = config.appName ?? DEFAULT_APP_NAME;
  const image: Image = modal.images.fromRegistry(config.image ?? DEFAULT_IMAGE);
  const handles = new Map<string, Sandbox>();
  let appPromise: Promise<App> | undefined;

  const toError = (error: unknown, context: string, notFound: NotFoundMeans) =>
    toProviderError(name, label, error, context, notFound);

  const getApp = (): Promise<App> => {
    appPromise ??= modal.apps.fromName(appName, { createIfMissing: true, environment: config.environment }).catch((error) => {
      appPromise = undefined;
      throw error;
    });
    return appPromise;
  };

  /** `fromId` makes no RPC; an unknown id fails on the first call made through the handle. */
  const handle = async (providerSandboxId: string): Promise<Sandbox> => {
    const cached = handles.get(providerSandboxId);
    if (cached) return cached;
    const sandbox = await modal.sandboxes.fromId(providerSandboxId);
    if (handles.size >= HANDLE_CACHE_MAX) {
      const [oldestId, oldest] = handles.entries().next().value!;
      handles.delete(oldestId);
      oldest.detach();
    }
    handles.set(providerSandboxId, sandbox);
    return sandbox;
  };

  const forget = (providerSandboxId: string) => {
    handles.get(providerSandboxId)?.detach();
    handles.delete(providerSandboxId);
  };

  /**
   * Exec-based calls report a finished sandbox inconsistently (a conflict, a closed stream,
   * a raw gRPC status), so an unclear failure is checked against the control plane first.
   */
  const failOperation = async (
    providerSandboxId: string,
    error: unknown,
    context: string,
    notFound: NotFoundMeans,
  ): Promise<never> => {
    const mapped = toError(error, context, notFound);
    if (mapped.code === 'file_not_found' || mapped.code === 'rate_limited' || mapped.code === 'invalid_request') {
      throw mapped;
    }
    if (mapped.code === 'sandbox_not_found') {
      forget(providerSandboxId);
      throw mapped;
    }
    let exitCode: number | null = null;
    try {
      exitCode = await (await handle(providerSandboxId)).poll();
    } catch (pollError) {
      const pollMapped = toError(pollError, context, 'sandbox');
      if (pollMapped.code === 'sandbox_not_found') {
        forget(providerSandboxId);
        throw pollMapped;
      }
      throw mapped;
    }
    if (exitCode !== null) {
      forget(providerSandboxId);
      throw new ProviderError(name, 'sandbox_not_found', `${label} sandbox ${providerSandboxId} has finished`, { cause: error });
    }
    throw mapped;
  };

  /** Kills the process group recorded in `pidFile`, waiting briefly for the file if the command is just starting. */
  const killProcessGroup = async (sandbox: Sandbox, pidFile: string) => {
    const f = shellQuote(pidFile);
    const script = [
      `i=0; while [ ! -s ${f} ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done`,
      `[ -s ${f} ] || exit 0`,
      `pg=$(cat ${f})`,
      `kill -TERM -- "-$pg" 2>/dev/null`,
      `i=0; while kill -0 -- "-$pg" 2>/dev/null && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done`,
      `kill -KILL -- "-$pg" 2>/dev/null`,
      `rm -f ${f}`,
      'exit 0',
    ].join('\n');
    const killer = await sandbox.exec(['bash', '-c', script], { stdout: 'ignore', stderr: 'ignore' });
    await killer.wait();
  };

  return {
    name,
    maxLifetimeSeconds: MAX_LIFETIME_SECONDS,
    // Modal can't change a running sandbox's timeout (https://modal.com/docs/reference/modal.Sandbox).
    canExtendTimeout: false,

    resources: (size) => ({ ...SIZE_SPECS[size], diskMib: config.runtime === 'vm' ? VM_DISK_MIB : null }),

    ratePerHourMicros: (resources: Resources) => ratePerHour(PRICES, resources),

    async create({ size, timeoutSeconds, sandboxId }): Promise<CreatedSandbox> {
      const cores = MODAL_CPU_CORES[size];
      const { memoryMib } = SIZE_SPECS[size];
      let sandbox: Sandbox;
      try {
        const app = await getApp();
        sandbox = await modal.sandboxes.create(app, image, {
          runtime: config.runtime,
          cpu: cores,
          cpuLimit: cores,
          memoryMiB: memoryMib,
          memoryLimitMiB: memoryMib,
          // Must be a whole number of seconds.
          timeoutMs: Math.min(Math.ceil(timeoutSeconds) + DEADLINE_MARGIN_SECONDS, MAX_LIFETIME_SECONDS) * 1000,
          encryptedPorts: MODAL_EXPOSED_PORTS,
          tags: { [SANDBOX_ID_LABEL]: sandboxId, [RUNTIME_TAG]: config.runtime },
        });
      } catch (error) {
        // The SDK terminates a sandbox that was created but never scheduled.
        throw toError(error, 'create', 'other');
      }
      try {
        // The home directory depends on the image's user; registry images usually run as root.
        const probe = await sandbox.exec(['sh', '-c', 'printf %s "$HOME"'], { stderr: 'ignore' });
        const [home, exitCode] = await Promise.all([probe.stdout.readText(), probe.wait()]);
        if (exitCode !== 0) throw new Error(`probing $HOME exited with ${exitCode}`);
        handles.set(sandbox.sandboxId, sandbox);
        return {
          providerSandboxId: sandbox.sandboxId,
          // Modal doesn't report allocations back, so these are what we requested (and capped).
          // Confirm in the smoke test that `nproc`/cgroup limits match 1/2/4 vCPU.
          cpu: SIZE_SPECS[size].cpu,
          memoryMib,
          diskMib: config.runtime === 'vm' ? VM_DISK_MIB : null,
          homeDir: home.trim() || '/root',
          // Modal's creation time is only on an internal API; the router then counts from
          // before the create call, which is never later than Modal's own start.
          startedAt: null,
        };
      } catch (error) {
        // Don't leave a sandbox running that we can't use.
        await sandbox.terminate().catch(() => {});
        sandbox.detach();
        throw toError(error, 'create', 'sandbox');
      }
    },

    async kill(providerSandboxId) {
      try {
        // Confirm in the smoke test that terminating an already finished sandbox succeeds.
        await (await handle(providerSandboxId)).terminate();
      } catch (error) {
        const mapped = toError(error, 'kill', 'sandbox');
        if (mapped.code !== 'sandbox_not_found') throw mapped;
      } finally {
        forget(providerSandboxId);
      }
    },

    async setTimeout() {
      // Modal can't move a running sandbox's deadline (canExtendTimeout is false). Shortening
      // needs nothing here: we kill the sandbox at the new deadline ourselves.
    },

    async listTagged(): Promise<TaggedSandbox[]> {
      const sandboxes: Sandbox[] = [];
      try {
        const app = await getApp();
        // Only running sandboxes are listed. Tags filter on exact key=value, and list results
        // carry no tags, so the id label is read per sandbox.
        for await (const sandbox of modal.sandboxes.list({ appId: app.appId, tags: { [RUNTIME_TAG]: config.runtime } })) {
          sandboxes.push(sandbox);
        }
      } catch (error) {
        for (const sandbox of sandboxes) sandbox.detach();
        throw toError(error, 'list', 'other');
      }
      const result: TaggedSandbox[] = [];
      try {
        for (let i = 0; i < sandboxes.length; i += LIST_TAGS_CONCURRENCY) {
          const batch = sandboxes.slice(i, i + LIST_TAGS_CONCURRENCY);
          await Promise.all(
            batch.map(async (sandbox) => {
              try {
                const sandboxId = (await sandbox.getTags())[SANDBOX_ID_LABEL];
                if (sandboxId) result.push({ providerSandboxId: sandbox.sandboxId, sandboxId });
              } catch (error) {
                // A sandbox that finished since the listing is simply left out.
                const mapped = toError(error, 'get tags', 'sandbox');
                if (mapped.code !== 'sandbox_not_found') throw mapped;
              }
            }),
          );
        }
      } finally {
        for (const sandbox of sandboxes) sandbox.detach();
      }
      return result;
    },

    async isAlive(providerSandboxId) {
      try {
        // Null while running, the exit code once finished.
        const exitCode = await (await handle(providerSandboxId)).poll();
        if (exitCode !== null) forget(providerSandboxId);
        return exitCode === null;
      } catch (error) {
        // Confirm in the smoke test which error an unknown id produces (NotFoundError or raw NOT_FOUND).
        const mapped = toError(error, 'poll', 'sandbox');
        if (mapped.code === 'sandbox_not_found') {
          forget(providerSandboxId);
          return false;
        }
        throw mapped;
      }
    },

    async exec(ref, request): Promise<ExecResult> {
      if (request.signal.aborted) return { exitCode: null, timedOut: false };
      const sandbox = await handle(ref.providerSandboxId);
      // Modal has no API to kill a running exec, so the command runs as the leader of its own
      // process group and records the group id; a second exec kills the group on timeout or abort.
      // `setsid -w` waits for the command and passes its exit status through.
      const pidFile = `/tmp/.sandboxrouter-exec-${randomUUID()}.pgid`;
      const f = shellQuote(pidFile);
      const script = [
        `echo $$ > ${f}`,
        `cd ${shellQuote(request.cwd)} || { rm -f ${f}; exit 1; }`,
        `bash -lc ${shellQuote(request.command)} </dev/null`,
        'status=$?',
        `rm -f ${f}`,
        'exit $status',
      ].join('\n');

      let proc: ContainerProcess<string>;
      try {
        // No SDK timeoutMs: it only ends the client's wait and isn't known to kill the group.
        proc = await sandbox.exec(['setsid', '-w', 'bash', '-c', script], {
          mode: 'text',
          env: request.env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, 'exec', 'sandbox');
      }

      const readers = [proc.stdout.getReader(), proc.stderr.getReader()] as const;
      const pump = async (reader: ReadableStreamDefaultReader<string>, onChunk: (chunk: string) => void | Promise<void>) => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value) await onChunk(value);
        }
      };
      const finished = Promise.all([
        proc.wait(),
        pump(readers[0], request.onStdout),
        pump(readers[1], request.onStderr),
      ]).then(([exitCode]) => exitCode);
      finished.catch(() => {});

      let timedOut = false;
      let stop: () => void = () => {};
      const stopped = new Promise<'stopped'>((resolve) => {
        stop = () => resolve('stopped');
      });
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, request.timeoutMs);
      const onAbort = () => stop();
      request.signal.addEventListener('abort', onAbort, { once: true });
      // The caller may have gone away while the command was starting.
      if (request.signal.aborted) stop();

      try {
        const outcome = await Promise.race([finished, stopped]);
        if (outcome !== 'stopped') return { exitCode: outcome, timedOut: false };
        try {
          await killProcessGroup(sandbox, pidFile);
        } catch (error) {
          return failOperation(ref.providerSandboxId, error, 'kill command', 'sandbox');
        }
        // Let the killed command's exec report its end and flush output, but don't hang on it.
        let waitTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          finished.catch(() => {}),
          new Promise((resolve) => {
            waitTimer = setTimeout(resolve, KILLED_EXEC_WAIT_MS);
          }),
        ]);
        clearTimeout(waitTimer);
        for (const reader of readers) reader.cancel().catch(() => {});
        return { exitCode: null, timedOut };
      } catch (error) {
        // An output callback failed or the exec broke; don't leave the command running.
        void killProcessGroup(sandbox, pidFile).catch(() => {});
        for (const reader of readers) reader.cancel().catch(() => {});
        return failOperation(ref.providerSandboxId, error, 'exec', 'sandbox');
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      }
    },

    async startBackground(ref, request) {
      const sandbox = await handle(ref.providerSandboxId);
      // A new session with no stdio tied to the exec, so the exec ends at once and the process
      // outlives it. Confirm in the smoke test that Modal doesn't reap it when the exec exits.
      const script = [
        `cd ${shellQuote(request.cwd)} || exit 1`,
        `nohup setsid bash -lc ${shellQuote(request.command)} </dev/null >/dev/null 2>&1 &`,
      ].join('\n');
      let exitCode: number;
      let stderr: string;
      try {
        const proc = await sandbox.exec(['bash', '-c', script], { env: request.env, stdout: 'ignore', stderr: 'pipe' });
        [exitCode, stderr] = await Promise.all([proc.wait(), proc.stderr.readText()]);
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, 'start background command', 'sandbox');
      }
      if (exitCode !== 0) {
        throw new ProviderError(
          name,
          'invalid_request',
          `${label} start background command failed (exit ${exitCode}): ${stderr.trim() || 'no output'}`,
        );
      }
    },

    async readFile(ref, path) {
      const sandbox = await handle(ref.providerSandboxId);
      // filesystem.readBytes buffers the whole file and has an unpublished size limit, so the
      // path is checked with the filesystem API and then streamed with cat.
      let proc: ContainerProcess<Uint8Array>;
      try {
        const info = await sandbox.filesystem.stat(path);
        if (info.type === 'directory') {
          throw new ProviderError(name, 'invalid_request', `${label} read ${path} failed: it is a directory`);
        }
        proc = await sandbox.exec(['cat', '--', path], { mode: 'binary', stdout: 'pipe', stderr: 'ignore' });
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, `read ${path}`, 'sandbox');
      }
      const reader = proc.stdout.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (!done) {
              controller.enqueue(value);
              return;
            }
            const exitCode = await proc.wait();
            if (exitCode === 0) controller.close();
            else controller.error(new ProviderError(name, 'unknown', `${label} read ${path} failed: cat exited with ${exitCode}`));
          } catch (error) {
            controller.error(toError(error, `read ${path}`, 'sandbox'));
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
    },

    async writeFile(ref, path, data) {
      const sandbox = await handle(ref.providerSandboxId);
      // writeBytes takes the whole file (uploads are capped well below memory limits upstream).
      // It creates parent directories and overwrites. Confirm its size limit in the smoke test.
      const chunks: Uint8Array[] = [];
      for await (const chunk of data) chunks.push(chunk);
      try {
        await sandbox.filesystem.writeBytes(Buffer.concat(chunks), path);
      } catch (error) {
        await failOperation(ref.providerSandboxId, error, `write ${path}`, 'sandbox');
      }
    },

    async listFiles(ref, path): Promise<FileEntry[]> {
      const sandbox = await handle(ref.providerSandboxId);
      try {
        const entries = await sandbox.filesystem.listFiles(path);
        return entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type === 'directory' ? 'dir' : entry.type === 'symlink' ? 'symlink' : 'file',
          size: entry.size,
          modifiedAt: entry.modifiedTime > 0 ? new Date(entry.modifiedTime * 1000).toISOString() : null,
        }));
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, `list ${path}`, 'sandbox');
      }
    },

    async removeFile(ref, path) {
      const sandbox = await handle(ref.providerSandboxId);
      try {
        await sandbox.filesystem.remove(path, { recursive: true });
      } catch (error) {
        await failOperation(ref.providerSandboxId, error, `remove ${path}`, 'sandbox');
      }
    },

    async portUrl(ref, port) {
      if (!MODAL_EXPOSED_PORTS.includes(port)) {
        throw new ProviderError(
          name,
          'invalid_request',
          `${label} exposes only ports ${MODAL_EXPOSED_PORTS.join(', ')}; port ${port} was not declared when the sandbox was created`,
        );
      }
      const sandbox = await handle(ref.providerSandboxId);
      try {
        const tunnel = (await sandbox.tunnels(TUNNELS_TIMEOUT_MS))[port];
        if (!tunnel) throw new ProviderError(name, 'unavailable', `${label} has no tunnel for port ${port}`);
        // Tunnels are public HTTPS for the sandbox's whole life; confirm there is no earlier expiry in the smoke test.
        return { url: tunnel.url, expiresAt: null };
      } catch (error) {
        return failOperation(ref.providerSandboxId, error, `tunnel port ${port}`, 'sandbox');
      }
    },
  };
}

/** gRPC status codes (https://grpc.io/docs/guides/status-codes/). */
const GRPC = {
  CANCELLED: 1,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

/** nice-grpc's ClientError, which the SDK lets escape for statuses it doesn't translate. */
function grpcCode(error: unknown): number | undefined {
  if (error instanceof Error && error.name === 'ClientError' && typeof (error as { code?: unknown }).code === 'number') {
    return (error as unknown as { code: number }).code;
  }
  return undefined;
}

function toProviderError(
  provider: ProviderName,
  label: string,
  error: unknown,
  context: string,
  notFound: NotFoundMeans,
): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = `${label} ${context} failed: ${errorMessage(error)}`;
  const code = ((): ProviderErrorCode => {
    // The filesystem errors share a parent class, so check not-found before the rest.
    if (error instanceof SandboxFilesystemNotFoundError) return 'file_not_found';
    // Directory/permission/size errors, all caused by the request.
    if (error instanceof SandboxFilesystemError && error.constructor !== SandboxFilesystemError) return 'invalid_request';
    if (error instanceof SandboxFilesystemError) return 'unknown';
    // The filesystem API also reports a sandbox that has shut down as NotFoundError.
    if (error instanceof NotFoundError) return notFound === 'other' ? 'invalid_request' : 'sandbox_not_found';
    // Raised when a sandbox has already finished (e.g. exec on a terminated sandbox).
    if (error instanceof ConflictError) return notFound === 'other' ? 'unavailable' : 'sandbox_not_found';
    if (error instanceof InvalidError || error instanceof AlreadyExistsError) return 'invalid_request';
    // Insufficient capacity, or scheduling timed out.
    if (error instanceof ResourceExhaustedError) return 'unavailable';
    if (error instanceof SandboxTimeoutError || error instanceof TimeoutError || error instanceof ClientClosedError) {
      return 'unavailable';
    }
    const grpc = grpcCode(error);
    switch (grpc) {
      case GRPC.NOT_FOUND:
        return notFound === 'sandbox' ? 'sandbox_not_found' : 'invalid_request';
      case GRPC.RESOURCE_EXHAUSTED:
        return 'rate_limited';
      case GRPC.INVALID_ARGUMENT:
      case GRPC.ALREADY_EXISTS:
      case GRPC.FAILED_PRECONDITION:
      case GRPC.OUT_OF_RANGE:
        return 'invalid_request';
      case GRPC.UNAUTHENTICATED:
      case GRPC.PERMISSION_DENIED:
      case GRPC.UNAVAILABLE:
      case GRPC.DEADLINE_EXCEEDED:
      case GRPC.INTERNAL:
      case GRPC.CANCELLED:
      case GRPC.UNIMPLEMENTED:
        return 'unavailable';
    }
    return 'unknown';
  })();
  return new ProviderError(provider, code, message, { cause: error });
}
