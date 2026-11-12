import { z } from '@hono/zod-openapi';
import {
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
  PRESETS,
  costMicros,
  microsToUsd,
  type ApiKeySummary,
  type SandboxRow,
} from '@sr/core';
import { SANDBOX_STATUSES, END_REASONS } from '@sr/db';
import { PROVIDER_NAMES, SIZES } from '@sr/providers';

export const MAX_EXEC_TIMEOUT_SECONDS = 60 * 60;
export const DEFAULT_EXEC_TIMEOUT_SECONDS = 60;

export const ErrorBody = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'insufficient_funds' }),
      message: z.string(),
    }),
  })
  .openapi('Error');

export const timestamp = z.string().openapi({ format: 'date-time', example: '2026-11-03T12:00:00.000Z' });
export const usd = (description: string) => z.number().openapi({ description, example: 0.1656 });

export const SandboxIdParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'sbx_a7k2m9q4w1e8r5t3y6u0' }),
});

export const Sandbox = z
  .object({
    id: z.string(),
    status: z.enum(SANDBOX_STATUSES).openapi({
      description: '`creating` while being placed, `running` once usable, then `ended`. `failed` if no provider could create it.',
    }),
    size: z.enum(SIZES),
    preset: z.enum(PRESETS).nullable().openapi({ description: 'Routing preset used; null when a provider was pinned.' }),
    provider: z.enum(PROVIDER_NAMES).nullable(),
    cpu: z.number().int().nullable(),
    memoryMib: z.number().int().nullable(),
    diskMib: z.number().int().nullable(),
    homeDir: z.string().nullable().openapi({ description: 'Relative paths in exec and file calls resolve against this.' }),
    pricePerHourUsd: usd('List price per hour while running.'),
    costUsd: usd('Final cost once ended; cost so far while running.'),
    createdAt: timestamp,
    expiresAt: timestamp.openapi({ description: 'The sandbox is killed at this time unless extended.' }),
    endedAt: timestamp.nullable(),
    endReason: z.enum(END_REASONS).nullable(),
    metadata: z.record(z.string(), z.string()),
  })
  .openapi('Sandbox');

export function toSandbox(row: SandboxRow): z.infer<typeof Sandbox> {
  const cost =
    row.status === 'running' && row.billingStartedAt
      ? costMicros(row.ratePerHourMicros, Math.min(Date.now(), row.expiresAt.getTime()) - row.billingStartedAt.getTime())
      : (row.costMicros ?? 0);
  return {
    id: row.id,
    status: row.status,
    size: row.size as z.infer<typeof Sandbox>['size'],
    preset: row.preset as z.infer<typeof Sandbox>['preset'],
    provider: row.provider as z.infer<typeof Sandbox>['provider'],
    cpu: row.cpu,
    memoryMib: row.memoryMib,
    diskMib: row.diskMib,
    homeDir: row.homeDir,
    pricePerHourUsd: microsToUsd(row.ratePerHourMicros),
    costUsd: microsToUsd(cost),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
    metadata: row.metadata,
  };
}

export const CreateSandboxBody = z
  .object({
    size: z.enum(SIZES).default('small').openapi({ description: 'small: 1 vCPU / 1 GiB, medium: 2 vCPU / 4 GiB, large: 4 vCPU / 8 GiB.' }),
    preset: z.enum(PRESETS).default('cheap').openapi({
      description: '`cheap` picks the lowest price, `fast` the lowest recent create latency. Ignored when `provider` is set.',
    }),
    provider: z.enum(PROVIDER_NAMES).optional().openapi({ description: 'Pin a provider instead of routing.' }),
    timeout: z
      .number()
      .int()
      .min(MIN_TIMEOUT_SECONDS)
      .max(MAX_TIMEOUT_SECONDS)
      .default(DEFAULT_TIMEOUT_SECONDS)
      .openapi({ description: 'Seconds until the sandbox is killed. Extend with POST /v1/sandboxes/{id}/timeout.' }),
    metadata: z
      .record(z.string().min(1).max(64), z.string().max(512))
      .refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata keys')
      .default({}),
  })
  .openapi('CreateSandbox');

export const SetTimeoutBody = z
  .object({
    timeout: z
      .number()
      .int()
      .min(MIN_TIMEOUT_SECONDS)
      .max(MAX_TIMEOUT_SECONDS)
      .openapi({ description: 'Seconds from now until the sandbox is killed.' }),
  })
  .openapi('SetTimeout');

export const ListSandboxesQuery = z.object({
  status: z.enum(SANDBOX_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().optional().openapi({ description: 'Pass `nextCursor` from the previous page.' }),
});

export const SandboxList = z
  .object({ data: z.array(Sandbox), nextCursor: z.string().nullable() })
  .openapi('SandboxList');

export const ExecBody = z
  .object({
    command: z.string().min(1).openapi({ description: 'Run with `bash -lc`.', example: 'python3 --version' }),
    cwd: z.string().optional().openapi({ description: 'Defaults to the home directory.' }),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid environment variable name'), z.string()).default({}),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(MAX_EXEC_TIMEOUT_SECONDS)
      .default(DEFAULT_EXEC_TIMEOUT_SECONDS)
      .openapi({ description: 'Seconds before the command is killed. Ignored for background commands.' }),
    background: z.boolean().default(false).openapi({
      description: 'Start the command and return immediately. It runs until it exits or the sandbox ends; its output is discarded unless redirected.',
    }),
  })
  .openapi('Exec');

export const ExecResult = z
  .object({
    exitCode: z.number().int().nullable().openapi({ description: 'Null when the command was killed by its timeout.' }),
    timedOut: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.boolean().openapi({ description: 'True when output beyond 10 MiB per stream was dropped.' }),
    durationMs: z.number().int(),
  })
  .openapi('ExecResult');

export const ExecStreamEvent = z
  .discriminatedUnion('event', [
    z.object({ event: z.literal('stdout'), data: z.string() }),
    z.object({ event: z.literal('stderr'), data: z.string() }),
    z.object({
      event: z.literal('exit'),
      data: z.object({ exitCode: z.number().int().nullable(), timedOut: z.boolean(), durationMs: z.number().int() }),
    }),
    z.object({ event: z.literal('error'), data: ErrorBody.shape.error }),
  ])
  .openapi('ExecStreamEvent', {
    description: 'Each SSE event carries a JSON-encoded `data` field: a string chunk for stdout/stderr, an object for exit/error.',
  });

export const PathQuery = z.object({
  path: z.string().min(1).openapi({ description: 'Absolute, or relative to the home directory.', example: 'app/main.py' }),
});

export const ListFilesQuery = z.object({
  path: z.string().min(1).default('.').openapi({ description: 'Directory to list; defaults to the home directory.' }),
});

export const FileEntry = z
  .object({
    name: z.string(),
    path: z.string(),
    type: z.enum(['file', 'dir', 'symlink']),
    size: z.number().int(),
    modifiedAt: timestamp.nullable(),
  })
  .openapi('FileEntry');

export const FileList = z.object({ data: z.array(FileEntry) }).openapi('FileList');

export const PortParams = SandboxIdParam.extend({
  port: z.coerce.number().int().min(1).max(65535).openapi({ param: { name: 'port', in: 'path' }, example: 3000 }),
});

export const PortUrl = z
  .object({
    url: z.string().openapi({ example: 'https://3000-abc123.e2b.app' }),
    expiresAt: timestamp.nullable().openapi({ description: 'When the URL stops working; null if it lasts as long as the sandbox.' }),
  })
  .openapi('PortUrl');

export const ProviderInfo = z
  .object({
    name: z.enum(PROVIDER_NAMES),
    maxTimeoutSeconds: z.number().int(),
    sizes: z.array(
      z.object({
        size: z.enum(SIZES),
        cpu: z.number().int(),
        memoryMib: z.number().int(),
        diskMib: z.number().int().nullable(),
        pricePerHourUsd: z.number(),
      }),
    ),
    health: z.object({
      medianCreateMs: z.number().int().nullable(),
      successRate: z.number().nullable(),
      failing: z.boolean(),
    }),
  })
  .openapi('Provider');

export const ProviderList = z.object({ data: z.array(ProviderInfo) }).openapi('ProviderList');

export const ApiKey = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().openapi({ description: 'The first characters of the key.' }),
    createdAt: timestamp,
    lastUsedAt: timestamp.nullable(),
  })
  .openapi('ApiKey');

export function toApiKey(key: ApiKeySummary): z.infer<typeof ApiKey> {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  };
}

export const CreatedApiKey = ApiKey.extend({
  key: z.string().openapi({ description: 'The full key. It is shown only once.' }),
}).openapi('CreatedApiKey');

export const CreateApiKeyBody = z.object({ name: z.string().trim().min(1).max(100) }).openapi('CreateApiKey');

export const ApiKeyIdParam = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
});

export type SandboxJson = z.infer<typeof Sandbox>;
export type SandboxListJson = z.infer<typeof SandboxList>;
export type ProviderListJson = z.infer<typeof ProviderList>;
export type ApiKeyJson = z.infer<typeof ApiKey>;
export type CreatedApiKeyJson = z.infer<typeof CreatedApiKey>;
export type ErrorJson = z.infer<typeof ErrorBody>;
