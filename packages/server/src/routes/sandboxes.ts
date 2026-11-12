import { createRoute, z } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { AppError } from '@sr/core';
import type { App, AppEnv, ServerDeps } from '../context.ts';
import { toErrorBody } from '../errors.ts';
import {
  CreateSandboxBody,
  ErrorBody,
  ExecBody,
  ExecResult,
  ExecStreamEvent,
  FileList,
  ListFilesQuery,
  ListSandboxesQuery,
  PathQuery,
  PortParams,
  PortUrl,
  Sandbox,
  SandboxIdParam,
  SandboxList,
  SetTimeoutBody,
  toSandbox,
} from '../schemas.ts';
import { createErrors, errors, extendErrors, sandboxErrors, security } from './common.ts';

/** Per-stream cap on output returned by a non-streaming exec. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Output waiting to be sent to a slow streaming client before it is dropped. */
const MAX_QUEUED_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

export function registerSandboxRoutes(app: App, deps: ServerDeps, auth: MiddlewareHandler<AppEnv>) {
  const json = <T extends z.ZodType>(schema: T, description: string) => ({
    description,
    content: { 'application/json': { schema } },
  });
  const body = <T extends z.ZodType>(schema: T) => ({
    body: { content: { 'application/json': { schema } }, required: true },
  });

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sandboxes',
      tags: ['Sandboxes'],
      summary: 'Create a sandbox',
      description:
        'Places the sandbox on the best provider for the preset, failing over to the next one if creation fails. ' +
        'On Sandbox Router Cloud, funds for the full timeout are reserved from your balance until the sandbox ends, and you are charged only for the time it runs. Self-hosted deployments record the cost without charging.',
      security,
      middleware: [auth],
      request: body(CreateSandboxBody),
      responses: { 201: json(Sandbox, 'The running sandbox'), ...createErrors },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const row = await deps.sandboxes.create(c.get('accountId'), {
        size: input.size,
        timeoutSeconds: input.timeout,
        preset: input.preset,
        provider: input.provider,
        metadata: input.metadata,
      });
      return c.json(toSandbox(row), 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sandboxes',
      tags: ['Sandboxes'],
      summary: 'List sandboxes',
      description: 'Newest first.',
      security,
      middleware: [auth],
      request: { query: ListSandboxesQuery },
      responses: { 200: json(SandboxList, 'A page of sandboxes'), ...errors },
    }),
    async (c) => {
      const query = c.req.valid('query');
      const rows = await deps.sandboxes.list(c.get('accountId'), {
        status: query.status,
        limit: query.limit,
        before: query.before,
      });
      const last = rows.at(-1);
      return c.json(
        {
          data: rows.map(toSandbox),
          nextCursor: rows.length === query.limit && last ? last.id : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sandboxes/{id}',
      tags: ['Sandboxes'],
      summary: 'Get a sandbox',
      security,
      middleware: [auth],
      request: { params: SandboxIdParam },
      responses: { 200: json(Sandbox, 'The sandbox'), ...errors },
    }),
    async (c) => c.json(toSandbox(await deps.sandboxes.get(c.get('accountId'), c.req.valid('param').id)), 200),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/sandboxes/{id}',
      tags: ['Sandboxes'],
      summary: 'Kill a sandbox',
      description: 'Stops the sandbox and charges for the time it ran. Killing an ended sandbox returns it unchanged.',
      security,
      middleware: [auth],
      request: { params: SandboxIdParam },
      responses: { 200: json(Sandbox, 'The ended sandbox'), ...sandboxErrors },
    }),
    async (c) => c.json(toSandbox(await deps.sandboxes.kill(c.get('accountId'), c.req.valid('param').id)), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sandboxes/{id}/timeout',
      tags: ['Sandboxes'],
      summary: 'Change the timeout',
      description: 'Sets the sandbox to be killed `timeout` seconds from now. Can extend or shorten it; the reserved funds follow.',
      security,
      middleware: [auth],
      request: { params: SandboxIdParam, ...body(SetTimeoutBody) },
      responses: { 200: json(Sandbox, 'The updated sandbox'), ...extendErrors },
    }),
    async (c) => {
      const row = await deps.sandboxes.setTimeout(c.get('accountId'), c.req.valid('param').id, c.req.valid('json').timeout);
      return c.json(toSandbox(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/sandboxes/{id}/exec',
      tags: ['Commands'],
      summary: 'Run a command',
      description:
        'Runs a command and returns its output when it exits. Send `Accept: text/event-stream` to stream output as it is produced instead. ' +
        'Closing the connection kills the command. Output a streaming client reads too slowly (over 8 MiB behind) is dropped, with a notice on stderr.',
      security,
      middleware: [auth],
      request: { params: SandboxIdParam, ...body(ExecBody) },
      responses: {
        200: {
          description: 'The finished command, or a stream of events',
          content: {
            'application/json': { schema: ExecResult },
            'text/event-stream': { schema: ExecStreamEvent },
          },
        },
        202: json(z.object({ started: z.literal(true) }), 'The background command started'),
        ...sandboxErrors,
      },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const { row, provider, ref, resolvePath, run } = await deps.sandboxes.live(c.get('accountId'), c.req.valid('param').id);
      const cwd = resolvePath(input.cwd ?? '.');

      if (input.background) {
        await run(() => provider.startBackground(ref, { command: input.command, cwd, env: input.env }));
        return c.json({ started: true as const }, 202);
      }

      // A command can't outlive its sandbox.
      const timeoutMs = Math.max(1, Math.min(input.timeout * 1000, row.expiresAt.getTime() - Date.now()));
      const startedAt = Date.now();

      if (c.req.header('accept')?.includes('text/event-stream')) {
        const response = streamSSE(c, async (stream) => {
          // Stop the command and unblock pending writes when the client goes away, including
          // if it left before streaming started.
          const controller = new AbortController();
          const disconnect = () => {
            controller.abort();
            stream.abort();
          };
          stream.onAbort(() => controller.abort());
          const requestSignal = c.req.raw.signal;
          requestSignal.addEventListener('abort', disconnect, { once: true });
          if (requestSignal.aborted) disconnect();

          // Writes are queued so events keep their order. Output waiting on a slow client is
          // capped; beyond the cap it is dropped and the client is told how much.
          let queue = Promise.resolve();
          let queuedBytes = 0;
          let droppedBytes = 0;
          const enqueue = (bytes: number, write: () => Promise<unknown>) => {
            queuedBytes += bytes;
            queue = queue.then(write).then(() => {
              queuedBytes -= bytes;
            });
            return queue;
          };
          const send = (event: string, data: unknown) => {
            const payload = JSON.stringify(data);
            return enqueue(payload.length, () => stream.writeSSE({ event, data: payload }));
          };
          const output = (event: 'stdout' | 'stderr') => (chunk: string) => {
            if (queuedBytes + chunk.length > MAX_QUEUED_STREAM_BYTES) {
              droppedBytes += chunk.length;
              return;
            }
            if (droppedBytes > 0) {
              const notice = `\n[sandboxrouter: dropped ${droppedBytes} bytes of output the client was too slow to read]\n`;
              droppedBytes = 0;
              void send('stderr', notice);
            }
            // Returning the write lets providers that wait on callbacks slow the command's output.
            return send(event, chunk);
          };
          const heartbeat = setInterval(() => {
            void enqueue(0, () => stream.write(': keep-alive\n\n'));
          }, HEARTBEAT_MS);
          try {
            const result = await run(() =>
              provider.exec(ref, {
                command: input.command,
                cwd,
                env: input.env,
                timeoutMs,
                onStdout: output('stdout'),
                onStderr: output('stderr'),
                signal: controller.signal,
              }),
            );
            void send('exit', { exitCode: result.exitCode, timedOut: result.timedOut, durationMs: Date.now() - startedAt });
          } catch (error) {
            void send('error', toErrorBody(error).error);
          } finally {
            clearInterval(heartbeat);
            requestSignal.removeEventListener('abort', disconnect);
            await queue;
          }
        });
        // Keep proxies from buffering or compressing the stream.
        response.headers.set('Cache-Control', 'no-cache, no-transform');
        response.headers.set('X-Accel-Buffering', 'no');
        return response;
      }

      const stdout = new OutputBuffer(MAX_OUTPUT_BYTES);
      const stderr = new OutputBuffer(MAX_OUTPUT_BYTES);
      const result = await run(() =>
        provider.exec(ref, {
          command: input.command,
          cwd,
          env: input.env,
          timeoutMs,
          onStdout: (chunk) => stdout.append(chunk),
          onStderr: (chunk) => stderr.append(chunk),
          signal: c.req.raw.signal,
        }),
      );
      return c.json(
        {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - startedAt,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sandboxes/{id}/files',
      tags: ['Files'],
      summary: 'List a directory',
      security,
      middleware: [auth],
      request: { params: SandboxIdParam, query: ListFilesQuery },
      responses: { 200: json(FileList, 'Directory entries'), ...sandboxErrors },
    }),
    async (c) => {
      const { provider, ref, resolvePath, run } = await deps.sandboxes.live(c.get('accountId'), c.req.valid('param').id);
      const entries = await run(() => provider.listFiles(ref, resolvePath(c.req.valid('query').path)));
      return c.json({ data: entries }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sandboxes/{id}/files/content',
      tags: ['Files'],
      summary: 'Download a file',
      security,
      middleware: [auth],
      request: { params: SandboxIdParam, query: PathQuery },
      responses: {
        200: {
          description: 'The file contents',
          content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
        },
        ...sandboxErrors,
      },
    }),
    async (c) => {
      const { provider, ref, resolvePath, run } = await deps.sandboxes.live(c.get('accountId'), c.req.valid('param').id);
      const stream = await run(() => provider.readFile(ref, resolvePath(c.req.valid('query').path)));
      return c.body(stream, 200, { 'Content-Type': 'application/octet-stream' });
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/v1/sandboxes/{id}/files/content',
      tags: ['Files'],
      summary: 'Upload a file',
      description: 'Writes the raw request body to the path, creating parent directories and replacing any existing file. Up to 100 MiB.',
      security,
      middleware: [auth],
      request: {
        params: SandboxIdParam,
        query: PathQuery,
        body: { content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } } },
      },
      responses: { 200: json(z.object({ path: z.string() }), 'The written path'), ...sandboxErrors, 413: errorResponse413 },
    }),
    async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw tooLarge();
      const { provider, ref, resolvePath, run } = await deps.sandboxes.live(c.get('accountId'), c.req.valid('param').id);
      const path = resolvePath(c.req.valid('query').path);
      // The body streams straight to the provider; a limit check runs as it passes through.
      const limit = byteLimit(MAX_UPLOAD_BYTES);
      const data = (c.req.raw.body ?? new Response(new Uint8Array()).body!).pipeThrough(limit.stream);
      try {
        await run(() => provider.writeFile(ref, path, data));
      } catch (error) {
        if (limit.exceeded) throw tooLarge();
        throw error;
      }
      return c.json({ path }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/sandboxes/{id}/files',
      tags: ['Files'],
      summary: 'Delete a file or directory',
      description: 'Directories are removed recursively.',
      security,
      middleware: [auth],
      request: { params: SandboxIdParam, query: PathQuery },
      responses: { 204: { description: 'Deleted' }, ...sandboxErrors },
    }),
    async (c) => {
      const { provider, ref, resolvePath, run } = await deps.sandboxes.live(c.get('accountId'), c.req.valid('param').id);
      await run(() => provider.removeFile(ref, resolvePath(c.req.valid('query').path)));
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/sandboxes/{id}/ports/{port}',
      tags: ['Sandboxes'],
      summary: 'Get a public URL for a port',
      description: 'Returns an HTTPS URL that reaches a server listening on this port inside the sandbox.',
      security,
      middleware: [auth],
      request: { params: PortParams },
      responses: { 200: json(PortUrl, 'The URL'), ...sandboxErrors },
    }),
    async (c) => {
      const { id, port } = c.req.valid('param');
      const { provider, ref, run } = await deps.sandboxes.live(c.get('accountId'), id);
      const url = await run(() => provider.portUrl(ref, port));
      return c.json({ url: url.url, expiresAt: url.expiresAt?.toISOString() ?? null }, 200);
    },
  );
}

const errorResponse413 = {
  description: 'The upload is larger than 100 MiB',
  content: { 'application/json': { schema: ErrorBody } },
};

function tooLarge(): AppError {
  return new AppError('payload_too_large', `Uploads are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB`);
}

/** Passes bytes through until `max` is exceeded, then errors the stream. */
function byteLimit(max: number) {
  let total = 0;
  const state = { exceeded: false };
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) {
        state.exceeded = true;
        controller.error(new Error('upload too large'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return {
    stream,
    get exceeded() {
      return state.exceeded;
    },
  };
}

/** Collects output up to a byte limit, dropping the rest. */
class OutputBuffer {
  private readonly chunks: string[] = [];
  private bytes = 0;
  truncated = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  append(chunk: string) {
    if (this.truncated) return;
    const size = Buffer.byteLength(chunk);
    if (this.bytes + size <= this.limit) {
      this.chunks.push(chunk);
      this.bytes += size;
      return;
    }
    const remaining = this.limit - this.bytes;
    this.chunks.push(Buffer.from(chunk).subarray(0, remaining).toString('utf8'));
    this.bytes = this.limit;
    this.truncated = true;
  }

  text() {
    return this.chunks.join('');
  }
}
