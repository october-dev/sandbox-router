import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Sandbox, type SandboxRouter, SandboxRouterError } from 'sandboxrouter';
import { CliError, UsageError } from './args.ts';

/** The server's limit on one upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const PARALLEL_TRANSFERS = 8;

export type Location = { kind: 'local'; path: string } | { kind: 'stdio' } | { kind: 'remote'; id: string; path: string };

/** `sbx_...:path` is a path in a sandbox (relative paths start at its home directory), `-` is stdin/stdout. */
export function parseLocation(arg: string): Location {
  if (arg === '-') return { kind: 'stdio' };
  const match = /^(sbx_[A-Za-z0-9]+):(.*)$/s.exec(arg);
  if (match) return { kind: 'remote', id: match[1]!, path: match[2] || '.' };
  return { kind: 'local', path: arg };
}

export interface CopyResult {
  files: Array<{ from: string; to: string; bytes: number }>;
  skipped: string[];
}

/** Into the directory rather than onto it: `dir/`, and `.` (the home directory). */
function remoteIsDir(path: string): boolean {
  return path.endsWith('/') || path === '.' || path === '';
}

export async function copy(
  router: SandboxRouter,
  from: Location,
  to: Location,
  options: { recursive: boolean },
): Promise<CopyResult> {
  if (from.kind === 'remote' && to.kind === 'remote') {
    throw new UsageError('Copying between two sandboxes is not supported; copy to a local path first', 'cp');
  }
  if (from.kind !== 'remote' && to.kind !== 'remote') {
    throw new UsageError('One side must be a sandbox path, like sbx_abc123:path/to/file', 'cp');
  }
  if (to.kind === 'remote') {
    const sandbox = await router.sandboxes.get(to.id);
    return upload(sandbox, from as Exclude<Location, { kind: 'remote' }>, to.path, options.recursive);
  }
  const remote = from as Extract<Location, { kind: 'remote' }>;
  const sandbox = await router.sandboxes.get(remote.id);
  return download(sandbox, remote.path, to, options.recursive);
}

async function upload(sandbox: Sandbox, from: Exclude<Location, { kind: 'remote' }>, to: string, recursive: boolean): Promise<CopyResult> {
  const label = (path: string) => `${sandbox.id}:${path}`;
  if (from.kind === 'stdio') {
    if (remoteIsDir(to)) throw new UsageError('Give a file name to copy stdin to, like sbx_abc123:notes.txt', 'cp');
    const counter = countBytes();
    await sandbox.files.write(to, (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>).pipeThrough(counter.stream));
    return { files: [{ from: '-', to: label(to), bytes: counter.bytes() }], skipped: [] };
  }

  const info = await statOrThrow(from.path);
  if (!info.isDirectory()) {
    const target = remoteIsDir(to) ? posix.join(to, basename(from.path)) : to;
    await uploadFile(sandbox, from.path, target, info.size);
    return { files: [{ from: from.path, to: label(target), bytes: info.size }], skipped: [] };
  }
  if (!recursive) throw new UsageError(`${from.path} is a directory; use -r to copy it`, 'cp');

  // Like `cp -r src dst`: the directory's contents land in `dst`, or in `dst/<name>` when dst ends with a slash.
  const root = remoteIsDir(to) ? posix.join(to, basename(resolve(from.path))) : to;
  const jobs: Array<{ local: string; remote: string; size: number }> = [];
  const skipped: string[] = [];
  for (const entry of await readdir(from.path, { recursive: true, withFileTypes: true })) {
    const local = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) continue;
    // Follows symbolic links to files; anything else (sockets, broken links) is skipped.
    const entryInfo = await stat(local).catch(() => undefined);
    if (!entryInfo?.isFile()) {
      skipped.push(local);
      continue;
    }
    jobs.push({ local, remote: posix.join(root, relative(from.path, local).split(sep).join('/')), size: entryInfo.size });
  }
  const tooBig = jobs.find((job) => job.size > MAX_UPLOAD_BYTES);
  if (tooBig) throw new CliError(`${tooBig.local} is larger than the 100 MiB upload limit`);
  await inParallel(jobs, (job) => uploadFile(sandbox, job.local, job.remote, job.size));
  return { files: jobs.map((job) => ({ from: job.local, to: label(job.remote), bytes: job.size })), skipped };
}

async function uploadFile(sandbox: Sandbox, local: string, remote: string, size: number) {
  if (size > MAX_UPLOAD_BYTES) throw new CliError(`${local} is larger than the 100 MiB upload limit`);
  await sandbox.files.write(remote, Readable.toWeb(createReadStream(local)) as ReadableStream<Uint8Array>);
}

async function download(sandbox: Sandbox, from: string, to: Exclude<Location, { kind: 'remote' }>, recursive: boolean): Promise<CopyResult> {
  const label = `${sandbox.id}:${from}`;
  if (to.kind === 'stdio') {
    if (recursive) throw new UsageError('A directory cannot be copied to stdout', 'cp');
    const counter = countBytes();
    const stream = await readRemote(sandbox, from);
    await pipeline(Readable.fromWeb(stream.pipeThrough(counter.stream) as never), process.stdout, { end: false });
    return { files: [{ from: label, to: '-', bytes: counter.bytes() }], skipped: [] };
  }

  const targetInfo = await stat(to.path).catch(() => undefined);
  const into = targetInfo?.isDirectory() || to.path.endsWith('/') || to.path.endsWith(sep);
  const absolute = posix.isAbsolute(from) ? from : posix.join(sandbox.data.homeDir ?? '/', from);
  const target = into ? join(to.path, posix.basename(absolute)) : to.path;

  const entries = recursive ? await listTree(sandbox, absolute) : undefined;
  if (!entries) {
    const bytes = await downloadFile(sandbox, from, target);
    return { files: [{ from: label, to: target, bytes }], skipped: [] };
  }

  const root = resolve(target);
  const skipped: string[] = [];
  const jobs: Array<{ remote: string; local: string }> = [];
  for (const entry of entries.files) {
    const local = resolve(root, ...posix.relative(absolute, entry).split('/'));
    // A sandbox could report paths outside the directory asked for; never write outside the target.
    if (!local.startsWith(root + sep)) {
      skipped.push(entry);
      continue;
    }
    jobs.push({ remote: entry, local });
  }
  skipped.push(...entries.skipped);
  await mkdir(root, { recursive: true });
  for (const dir of entries.dirs) {
    const local = resolve(root, ...posix.relative(absolute, dir).split('/'));
    if (local === root || local.startsWith(root + sep)) await mkdir(local, { recursive: true });
  }
  const files: CopyResult['files'] = [];
  await inParallel(jobs, async (job) => {
    files.push({ from: `${sandbox.id}:${job.remote}`, to: job.local, bytes: await downloadFile(sandbox, job.remote, job.local) });
  });
  return { files, skipped };
}

/**
 * Every file under `root`, or undefined when `root` is not a directory (so it is
 * copied as a single file).
 */
async function listTree(sandbox: Sandbox, root: string): Promise<{ files: string[]; dirs: string[]; skipped: string[] } | undefined> {
  const files: string[] = [];
  const dirs: string[] = [];
  const skipped: string[] = [];
  let first;
  try {
    first = await sandbox.files.list(root);
  } catch (error) {
    if (error instanceof SandboxRouterError && error.status >= 400 && error.status < 500) return undefined;
    throw error;
  }
  if (first.length === 1 && first[0]!.path === root && first[0]!.type === 'file') return undefined;
  const queue: Array<Awaited<ReturnType<Sandbox['files']['list']>>> = [first];
  const seen = new Set([root]);
  while (queue.length) {
    for (const entry of queue.shift()!) {
      if (!entry.path.startsWith(`${root}/`) || seen.has(entry.path)) {
        if (!seen.has(entry.path)) skipped.push(entry.path);
        continue;
      }
      seen.add(entry.path);
      if (entry.type === 'file') files.push(entry.path);
      else if (entry.type === 'dir') {
        dirs.push(entry.path);
        queue.push(await sandbox.files.list(entry.path));
      } else skipped.push(entry.path);
    }
  }
  return { files, dirs, skipped };
}

async function downloadFile(sandbox: Sandbox, remote: string, local: string): Promise<number> {
  const stream = await readRemote(sandbox, remote);
  await mkdir(dirname(local), { recursive: true });
  const counter = countBytes();
  await pipeline(Readable.fromWeb(stream.pipeThrough(counter.stream) as never), createWriteStream(local));
  return counter.bytes();
}

/** Names the file in errors, which the API reports without it. */
async function readRemote(sandbox: Sandbox, path: string): Promise<ReadableStream<Uint8Array>> {
  try {
    return await sandbox.files.readStream(path);
  } catch (error) {
    if (error instanceof SandboxRouterError) {
      throw new SandboxRouterError(error.status, error.code, `${sandbox.id}:${path}: ${error.message}`);
    }
    throw error;
  }
}

async function statOrThrow(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`${path}: no such file or directory`);
    throw error;
  }
}

function countBytes() {
  let total = 0;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, bytes: () => total };
}

async function inParallel<T>(items: T[], run: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_TRANSFERS, items.length) }, worker));
}
