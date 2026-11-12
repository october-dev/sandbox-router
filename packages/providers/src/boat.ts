import { randomUUID } from 'node:crypto';
import {
  BoatApi,
  Configuration,
  FetchError,
  ResponseError,
  followCommand,
  waitUntilReady,
  type CommandResponse,
  type Sandbox,
} from '@boatdev/sdk';
import { ProviderError, type ProviderErrorCode, errorMessage } from './errors.ts';
import { shellQuote } from './shell.ts';
import {
  SANDBOX_ID_LABEL,
  type CreatedSandbox,
  type ExecResult,
  type FileEntry,
  type Provider,
  type Resources,
  type Size,
  type TaggedSandbox,
} from './types.ts';

type Tier = 'small' | 'default' | 'large';

/**
 * boat has fixed machine types (https://docs.boat.dev/limits). Disk is user space, excluding the OS.
 * Prices are https://docs.boat.dev/pricing: billed per second, nothing while stopped.
 */
const TIERS: Record<Tier, { cpu: number; memoryGib: number; diskGib: number; perHourMicros: number }> = {
  small: { cpu: 2, memoryGib: 4, diskGib: 51, perHourMicros: 18_000 },
  default: { cpu: 4, memoryGib: 8, diskGib: 51, perHourMicros: 36_000 },
  large: { cpu: 8, memoryGib: 16, diskGib: 111, perHourMicros: 72_000 },
};
/** The smallest tier at least as large as each size. small and medium share `small`. */
const SIZE_TIERS: Record<Size, Tier> = { small: 'small', medium: 'small', large: 'default' };

// Every sandbox runs Ubuntu 24.04 as `user` in /home/user (https://docs.boat.dev/machines/tools).
const HOME_DIR = '/home/user';
/**
 * Constant label for listing: the label filter matches `key=value` exactly, and whether a
 * key-only filter (`sandboxrouter_id`) works is undocumented.
 */
const MARKER_LABEL = 'sandboxrouter';
const MARKER_VALUE = '1';
/**
 * boat counts the TTL from its own create time, which precedes the ready sandbox we report
 * by the boot time. This margin keeps boat's deadline after ours; we delete the sandbox at
 * our deadline.
 */
const DEADLINE_MARGIN_SECONDS = 120;
const READY_TIMEOUT_MS = 180_000;
/** States in which a sandbox exists and can (or soon will) run commands. */
const LIVE_STATES = new Set(['init', 'provisioning', 'provisioned', 'cloning', 'ready', 'idle', 'running']);
/** Signed file URLs only accept paths under these directories. */
const URL_ROOTS = ['/home/user', '/tmp'];

export interface BoatConfig {
  apiKey: string;
  /** API base, e.g. "https://boat.dev/api/v1". The SDK default is used when omitted. */
  baseUrl?: string;
  /** 7200 on the trial, 2592000 (30 days) on paid plans (https://docs.boat.dev/limits). */
  maxLifetimeSeconds: number;
}

/** What a 404 means depends on the call: the sandbox for control-plane calls, a path for file calls. */
type NotFoundMeans = 'sandbox' | 'file' | 'other';

export function createBoatProvider(config: BoatConfig): Provider {
  const boat = new BoatApi(
    new Configuration({ accessToken: config.apiKey, ...(config.baseUrl ? { basePath: config.baseUrl } : {}) }),
  );

  const fail = async (error: unknown, context: string, notFound: NotFoundMeans = 'other'): Promise<never> => {
    throw await toProviderError(error, context, notFound);
  };

  /**
   * A 404 from a file call doesn't say whether the path or the sandbox is missing, so it is
   * checked against the control plane: a missing sandbox wins over a missing file.
   */
  const failFile = async (providerSandboxId: string, error: unknown, context: string): Promise<never> => {
    const mapped = await toProviderError(error, context, 'file');
    if (mapped.code === 'file_not_found') {
      try {
        await boat.get({ sandboxId: providerSandboxId });
      } catch (getError) {
        const gone = await toProviderError(getError, 'get sandbox', 'sandbox');
        if (gone.code === 'sandbox_not_found') throw gone;
      }
    }
    throw mapped;
  };

  /** Runs a short shell script synchronously (600 s cap) and returns its result. */
  const sh = async (providerSandboxId: string, script: string, timeoutSeconds = 120): Promise<CommandResponse> => {
    const result = await boat.command({
      sandboxId: providerSandboxId,
      commandRequest: { command: `bash -c ${shellQuote(script)}`, timeoutSeconds },
    });
    if (!('exitCode' in result)) throw new Error('boat returned a detached result for a synchronous command');
    return result;
  };

  /**
   * `CommandRequest` has no env field, and its cwd is relative to /home/user, so both go into
   * the command line. `bash -lc` gives the same login-bash semantics as E2B.
   */
  const wrap = (command: string, cwd: string, env: Record<string, string>) => {
    const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`);
    return `cd ${shellQuote(cwd)} && env ${assignments.join(' ')} bash -lc ${shellQuote(command)}`;
  };

  const deleteSandbox = (providerSandboxId: string) =>
    // The confirm header must equal the id, or boat answers 409.
    boat.deleteSandbox({ sandboxId: providerSandboxId, xAsciiConfirmDelete: providerSandboxId });

  return {
    name: 'boat',
    maxLifetimeSeconds: config.maxLifetimeSeconds,
    // PATCH ttlSeconds sets the deadline to now + ttlSeconds, so it can move either way.
    canExtendTimeout: true,

    resources: (size) => tierResources(SIZE_TIERS[size]),

    ratePerHourMicros: (resources: Resources) => TIERS[tierFor(resources)].perHourMicros,

    async create({ size, timeoutSeconds, sandboxId }): Promise<CreatedSandbox> {
      const tier = SIZE_TIERS[size];
      let sandbox: Sandbox;
      try {
        const created = await boat.create({
          // Kept 24 h: a retried create returns the same sandbox instead of a second billable one.
          idempotencyKey: sandboxId,
          createSandboxRequest: {
            type: tier,
            name: sandboxId,
            ttlSeconds: Math.min(timeoutSeconds + DEADLINE_MARGIN_SECONDS, config.maxLifetimeSeconds),
            labels: { [SANDBOX_ID_LABEL]: sandboxId, [MARKER_LABEL]: MARKER_VALUE },
            // The sandbox goes to our users, so it gets none of the account's secrets or logins.
            noEnv: true,
            // No background snapshots (no CPU spent on them), and an expired sandbox's disk is
            // erased at stop instead of kept for 14 days. We never resume or fork.
            snapshots: false,
          },
        });
        sandbox = created.sandbox;
      } catch (error) {
        return fail(error, 'create');
      }
      try {
        sandbox = await waitUntilReady(boat, sandbox.id, { timeoutMs: READY_TIMEOUT_MS, intervalMs: 1_000 });
        // Commands are accepted before guest networking is up; wait (best effort) for DNS.
        await sh(
          sandbox.id,
          'for i in $(seq 60); do getent hosts boat.dev >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 0',
          60,
        ).catch(() => {});
        const fallback = tierResources(tier);
        return {
          providerSandboxId: sandbox.id,
          cpu: sandbox.vcpu ?? fallback.cpu,
          memoryMib: sandbox.memoryGB !== undefined ? sandbox.memoryGB * 1024 : fallback.memoryMib,
          diskMib: fallback.diskMib,
          homeDir: HOME_DIR,
          startedAt: sandbox.createdAt ?? null,
        };
      } catch (error) {
        // Don't leave a sandbox running that we can't use.
        await deleteSandbox(sandbox.id).catch(() => {});
        return fail(error, 'create');
      }
    },

    async kill(providerSandboxId) {
      try {
        // Deletion is asynchronous: boat answers with an operation and the sandbox 404s once
        // it completes. Accepting the deletion is enough for us.
        await deleteSandbox(providerSandboxId);
      } catch (error) {
        const mapped = await toProviderError(error, 'kill', 'sandbox');
        if (mapped.code === 'sandbox_not_found') return;
        // A key without delete scope gets 403 api_key_action_forbidden. Stop the sandbox so it
        // no longer bills, but still report the failure: it is not deleted.
        await boat.stop({ sandboxId: providerSandboxId }).catch(() => {});
        throw mapped;
      }
    },

    async setTimeout(ref) {
      // The deadline becomes now + ttlSeconds; rounding up never lands before ours.
      const seconds = Math.ceil((ref.expiresAt.getTime() - Date.now()) / 1000) + DEADLINE_MARGIN_SECONDS;
      try {
        await boat.update({
          sandboxId: ref.providerSandboxId,
          updateSandboxRequest: { ttlSeconds: Math.min(Math.max(60, seconds), config.maxLifetimeSeconds) },
        });
      } catch (error) {
        await fail(error, 'set timeout', 'sandbox');
      }
    },

    async listTagged(): Promise<TaggedSandbox[]> {
      const result: TaggedSandbox[] = [];
      let cursor: string | null = null;
      try {
        do {
          // States are filtered here rather than with `state=`, whose syntax is undocumented in
          // the SDK. Confirm in the live smoke test that the exact `key=value` label filter works.
          const page = await boat.sandboxes({ label: [`${MARKER_LABEL}=${MARKER_VALUE}`], limit: 100, cursor });
          for (const sandbox of page.sandboxes) {
            const sandboxId = sandbox.labels?.[SANDBOX_ID_LABEL];
            if (!sandboxId) continue;
            if (LIVE_STATES.has(sandbox.state)) {
              result.push({ providerSandboxId: sandbox.id, sandboxId });
            } else if (sandbox.state === 'archived') {
              // boat's TTL stops and archives a sandbox instead of deleting it. One of ours that
              // reached `archived` is past its deadline, so delete it (best effort: a key without
              // delete scope gets 403, and a deletion in progress may still list as archived).
              void deleteSandbox(sandbox.id).catch(() => {});
            }
          }
          cursor = page.pageInfo?.hasMore ? page.pageInfo.nextCursor : null;
        } while (cursor);
      } catch (error) {
        return fail(error, 'list');
      }
      return result;
    },

    async isAlive(providerSandboxId) {
      try {
        const { sandbox } = await boat.get({ sandboxId: providerSandboxId });
        return LIVE_STATES.has(sandbox.state);
      } catch (error) {
        const mapped = await toProviderError(error, 'get sandbox', 'sandbox');
        if (mapped.code === 'sandbox_not_found') return false;
        throw mapped;
      }
    },

    async exec(ref, request): Promise<ExecResult> {
      if (request.signal.aborted) return { exitCode: null, timedOut: false };
      const sandboxId = ref.providerSandboxId;
      // Only a detached command can be stopped, so every exec runs detached and is followed.
      const reading = new AbortController();
      let processId: number | null = null;
      let stopped: 'timeout' | 'abort' | null = null;
      const stop = (reason: 'timeout' | 'abort') => {
        if (stopped) return;
        stopped = reason;
        reading.abort();
        // stopCommand kills the whole process tree (SIGTERM, then SIGKILL after 5 s).
        if (processId !== null) void boat.stopCommand({ sandboxId, processId }).catch(() => {});
      };
      const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
      const onAbort = () => stop('abort');
      request.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const started = await boat.command({
          sandboxId,
          commandRequest: { command: wrap(request.command, request.cwd, request.env), detached: true },
        });
        if (!('processId' in started)) throw new Error('boat ran a detached command synchronously');
        processId = started.processId;
        // The command may have been stopped while it was starting.
        if (stopped) {
          void boat.stopCommand({ sandboxId, processId }).catch(() => {});
          return { exitCode: null, timedOut: stopped === 'timeout' };
        }
        for await (const frame of followCommand(boat, sandboxId, processId, { signal: reading.signal })) {
          if (frame.type === 'stdout' && frame.data) await request.onStdout(frame.data);
          else if (frame.type === 'stderr' && frame.data) await request.onStderr(frame.data);
          else if (frame.type === 'exit') {
            if (stopped) break;
            return { exitCode: frame.exitCode ?? null, timedOut: false };
          } else if (frame.type === 'error') {
            if (stopped) break;
            throw new Error(`command failed: ${frame.message ?? frame.error ?? 'unknown error'}`);
          }
        }
        if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
        throw new Error('command output ended without an exit status');
      } catch (error) {
        if (stopped) return { exitCode: null, timedOut: stopped === 'timeout' };
        return fail(error, 'exec', 'sandbox');
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      }
    },

    async startBackground(ref, request) {
      try {
        // Detached returns a process id at once; the process lives until it exits or the sandbox ends.
        await boat.command({
          sandboxId: ref.providerSandboxId,
          commandRequest: { command: wrap(request.command, request.cwd, request.env), detached: true },
        });
      } catch (error) {
        await fail(error, 'start background command', 'sandbox');
      }
    },

    async readFile(ref, path) {
      const sandboxId = ref.providerSandboxId;
      // Signed URLs only serve /home/user and /tmp, so other paths are copied into /tmp first.
      // Confirm in the live smoke test whether the API itself enforces this.
      const staged = underUrlRoots(path) ? null : `/tmp/.sandboxrouter-${randomUUID()}`;
      const cleanup = () => {
        if (staged) void sh(sandboxId, `rm -f -- ${shellQuote(staged)}`).catch(() => {});
      };
      try {
        if (staged) await stageWithShell(sh, sandboxId, `cp -- ${shellQuote(path)} ${shellQuote(staged)}`, path);
        const { url } = await boat.createDownloadUrl({ sandboxId, fileUrlRequest: { path: staged ?? path } });
        const response = await fetch(url);
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw httpError(response.status, `download ${path}`);
        }
        if (!staged) return response.body;
        // Removes the staged copy once the download ends, fails or is cancelled. (A plain
        // wrapper rather than a TransformStream `cancel` hook, which not every lib types.)
        const reader = response.body.getReader();
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                cleanup();
                controller.close();
              } else {
                controller.enqueue(value);
              }
            } catch (error) {
              cleanup();
              controller.error(error);
            }
          },
          async cancel(reason) {
            cleanup();
            await reader.cancel(reason);
          },
        });
      } catch (error) {
        cleanup();
        return failFile(sandboxId, error, `read ${path}`);
      }
    },

    async writeFile(ref, path, data) {
      const sandboxId = ref.providerSandboxId;
      // Upload URLs create missing directories, but only under /home/user and /tmp; other paths
      // are uploaded to /tmp and moved into place.
      const staged = underUrlRoots(path) ? null : `/tmp/.sandboxrouter-${randomUUID()}`;
      try {
        const { url } = await boat.createUploadUrl({ sandboxId, fileUrlRequest: { path: staged ?? path } });
        // A streamed body is sent chunked. Confirm in the live smoke test that the signed URL
        // accepts uploads without a Content-Length.
        const response = await fetch(url, { method: 'PUT', body: data, duplex: 'half' } as RequestInit);
        await response.body?.cancel();
        if (!response.ok) throw httpError(response.status, `upload ${path}`);
        if (staged) {
          const dir = path.slice(0, path.lastIndexOf('/')) || '/';
          await stageWithShell(
            sh,
            sandboxId,
            `mkdir -p -- ${shellQuote(dir)} && mv -f -- ${shellQuote(staged)} ${shellQuote(path)}`,
            path,
          );
        }
      } catch (error) {
        if (staged) void sh(sandboxId, `rm -f -- ${shellQuote(staged)}`).catch(() => {});
        await failFile(sandboxId, error, `write ${path}`);
      }
    },

    async listFiles(ref, path): Promise<FileEntry[]> {
      try {
        // At most 10,000 entries; `truncated` says when there were more.
        const { files } = await boat.listFiles({ sandboxId: ref.providerSandboxId, path });
        return files.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.isSymlink ? 'symlink' : entry.isDir ? 'dir' : 'file',
          size: entry.size,
          modifiedAt: entry.modifiedAt ? entry.modifiedAt.toISOString() : null,
        }));
      } catch (error) {
        return failFile(ref.providerSandboxId, error, `list ${path}`);
      }
    },

    async removeFile(ref, path) {
      try {
        await boat.deleteFile({ sandboxId: ref.providerSandboxId, path, recursive: true });
      } catch (error) {
        await failFile(ref.providerSandboxId, error, `remove ${path}`);
      }
    },

    async portUrl(ref, port) {
      try {
        // Idempotent, and the URL is stable for the sandbox's life. `_public` drops the
        // `_token` gate. The service must listen on a non-loopback address; confirm in the live
        // smoke test whether `localhost: true` also works for services bound to 0.0.0.0.
        const hosted = await boat.hostPort({
          sandboxId: ref.providerSandboxId,
          hostPortRequest: { port, _public: true },
        });
        if (!hosted.url) throw new Error('boat returned no URL');
        return { url: hosted.url, expiresAt: null };
      } catch (error) {
        return fail(error, `host port ${port}`, 'sandbox');
      }
    },
  };
}

function tierResources(tier: Tier): Resources {
  const spec = TIERS[tier];
  return { cpu: spec.cpu, memoryMib: spec.memoryGib * 1024, diskMib: spec.diskGib * 1024 };
}

/** The smallest tier that holds these resources (the largest one when none does). */
function tierFor(resources: Resources): Tier {
  const tiers = Object.keys(TIERS) as Tier[];
  return (
    tiers.find((tier) => TIERS[tier].cpu >= resources.cpu && TIERS[tier].memoryGib * 1024 >= resources.memoryMib) ??
    tiers[tiers.length - 1]!
  );
}

function underUrlRoots(path: string): boolean {
  if (!path.startsWith('/')) return !path.split('/').includes('..'); // relative to /home/user
  if (path.split('/').includes('..')) return false;
  return URL_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Runs a copy or move for a path outside the URL roots, mapping a missing source to file_not_found. */
async function stageWithShell(
  sh: (sandboxId: string, script: string) => Promise<CommandResponse>,
  sandboxId: string,
  script: string,
  path: string,
): Promise<void> {
  const result = await sh(sandboxId, script);
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
  const code: ProviderErrorCode = /no such file|not a directory/i.test(detail) ? 'file_not_found' : 'invalid_request';
  throw new ProviderError('boat', code, `boat ${path}: ${detail}`);
}

/** A failed request to a signed file URL, which the sandbox serves itself. */
function httpError(status: number, context: string): ProviderError {
  const code: ProviderErrorCode =
    status === 404 ? 'file_not_found' : status === 429 ? 'rate_limited' : status >= 500 ? 'unavailable' : 'invalid_request';
  return new ProviderError('boat', code, `boat ${context} failed: HTTP ${status}`);
}

/** Reads `{ error: { code, message } }` (and `retryable`) from an API error body. */
async function errorBody(error: ResponseError): Promise<{ code?: string; message?: string; retryable?: boolean }> {
  const body = (await error.response
    .clone()
    .json()
    .catch(() => undefined)) as
    | { retryable?: boolean; error?: { code?: string; message?: string; details?: { retryable?: boolean } } }
    | undefined;
  return {
    code: body?.error?.code,
    message: body?.error?.message,
    retryable: body?.retryable ?? body?.error?.details?.retryable,
  };
}

async function toProviderError(error: unknown, context: string, notFound: NotFoundMeans): Promise<ProviderError> {
  if (error instanceof ProviderError) return error;
  if (error instanceof FetchError) {
    return new ProviderError('boat', 'unavailable', `boat ${context} failed: ${errorMessage(error.cause)}`, {
      cause: error,
    });
  }
  if (!(error instanceof ResponseError)) {
    return new ProviderError('boat', 'unknown', `boat ${context} failed: ${errorMessage(error)}`, { cause: error });
  }
  const status = error.response.status;
  const body = await errorBody(error);
  const message = `boat ${context} failed: ${status}${body.code ? ` ${body.code}` : ''}: ${body.message ?? error.message}`;
  const code = ((): ProviderErrorCode => {
    if (status === 404) {
      if (body.code === 'file_not_found') return 'file_not_found';
      return notFound === 'sandbox' ? 'sandbox_not_found' : notFound === 'file' ? 'file_not_found' : 'unknown';
    }
    // A stopped (archived) sandbox refuses commands with a non-retryable 409; for us it is gone.
    if (status === 409 && body.code === 'sandbox_not_ready' && body.retryable !== true) return 'sandbox_not_found';
    if (status === 409) return 'unavailable'; // e.g. boat_starting
    // rate_limited (start window), limit_reached (concurrency), IP_RATE_LIMIT_EXCEEDED.
    if (status === 429) return 'rate_limited';
    // trial_machine_class_not_allowed / machine_class_plan_required: the plan can't run this size.
    if (status === 403 && body.code?.includes('machine_class')) return 'invalid_request';
    // 401 unauthorized, 402 billing_required, 403 org_suspended / api_key_action_forbidden.
    if (status === 401 || status === 402 || status === 403) return 'unavailable';
    // 503 out_of_capacity / no_ready_machine, 502 sandbox_direct_failed.
    if (status >= 500) return 'unavailable';
    if (status >= 400) return 'invalid_request';
    return 'unknown';
  })();
  return new ProviderError('boat', code, message, { cause: error });
}
