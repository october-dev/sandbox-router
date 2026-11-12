/**
 * Live smoke test: drives one real provider through the whole Provider interface
 * with a small sandbox, then kills it. Uses the same environment variables as the
 * server (see src/env.ts), so a provider is only available when its key is set.
 *
 *   E2B_API_KEY=... pnpm --filter @sr/providers smoke e2b
 *   DAYTONA_API_KEY=... pnpm --filter @sr/providers smoke daytona
 *
 * Costs a few cents at most: one small sandbox for about two minutes.
 * Exits non-zero if any step fails, and always tries to kill the sandbox.
 */
import { randomUUID } from 'node:crypto';
import { providersFromEnv } from '../src/env.ts';
import type { Provider, SandboxRef } from '../src/types.ts';

const name = process.argv[2];
const providers = providersFromEnv(process.env);
const provider = providers.find((p) => p.name === name);
if (!provider) {
  const available = providers.map((p) => p.name).join(', ') || 'none (set a provider API key)';
  console.error(`usage: smoke <provider>\navailable with the current environment: ${available}`);
  process.exit(2);
}

const TIMEOUT_SECONDS = 180;
const sandboxId = `sbx_smoke_${randomUUID().slice(0, 8)}`;
const results: Array<{ step: string; ok: boolean; detail: string; ms: number }> = [];

async function step<T>(label: string, run: () => Promise<T>, describe: (value: T) => string = () => ''): Promise<T | undefined> {
  const started = Date.now();
  try {
    const value = await run();
    results.push({ step: label, ok: true, detail: describe(value), ms: Date.now() - started });
    return value;
  } catch (error) {
    results.push({ step: label, ok: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    return undefined;
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function collect(p: Provider, ref: SandboxRef, command: string, cwd: string, env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const result = await p.exec(ref, {
    command,
    cwd,
    env,
    timeoutMs: 30_000,
    onStdout: (chunk) => void (stdout += chunk),
    onStderr: (chunk) => void (stderr += chunk),
    signal: new AbortController().signal,
  });
  return { ...result, stdout, stderr };
}

const created = await step(
  'create (small)',
  () => provider.create({ size: 'small', timeoutSeconds: TIMEOUT_SECONDS, sandboxId }),
  (s) => `${s.providerSandboxId}, ${s.cpu} vCPU, ${s.memoryMib} MiB, home ${s.homeDir}`,
);

if (created) {
  const ref: SandboxRef = { providerSandboxId: created.providerSandboxId, expiresAt: new Date(Date.now() + TIMEOUT_SECONDS * 1000) };
  const home = created.homeDir;

  await step('isAlive', async () => check(await provider.isAlive(ref.providerSandboxId), 'reported not alive'));
  await step('listTagged finds it', async () => {
    const tagged = await provider.listTagged();
    check(tagged.some((t) => t.sandboxId === sandboxId && t.providerSandboxId === ref.providerSandboxId), `not among ${tagged.length} tagged sandboxes`);
  });
  await step(
    'exec: output, cwd, env, exit code',
    async () => {
      const r = await collect(provider, ref, 'echo out; echo err >&2; pwd; echo "$SR_SMOKE"; exit 3', home, { SR_SMOKE: 'hello world' });
      check(r.exitCode === 3, `exit code ${r.exitCode}`);
      check(r.stdout.includes('out') && r.stdout.includes(home) && r.stdout.includes('hello world'), `stdout ${JSON.stringify(r.stdout)}`);
      check(r.stderr.includes('err'), `stderr ${JSON.stringify(r.stderr)}`);
      return r;
    },
    (r) => `exit ${r.exitCode}`,
  );
  await step('exec: bash and python3 exist', async () => {
    const r = await collect(provider, ref, 'bash --version | head -1 && python3 --version', home);
    check(r.exitCode === 0, `exit ${r.exitCode}: ${r.stderr.trim()}`);
  });
  await step('exec: timeout', async () => {
    const r = await provider.exec(ref, {
      command: 'sleep 30',
      cwd: home,
      env: {},
      timeoutMs: 2_000,
      onStdout: () => {},
      onStderr: () => {},
      signal: new AbortController().signal,
    });
    check(r.timedOut && r.exitCode === null, `timedOut=${r.timedOut} exit=${r.exitCode}`);
  });
  await step('exec: abort', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_500);
    const started = Date.now();
    const r = await provider.exec(ref, { command: 'sleep 30', cwd: home, env: {}, timeoutMs: 30_000, onStdout: () => {}, onStderr: () => {}, signal: controller.signal });
    check(r.exitCode === null && Date.now() - started < 15_000, `exit=${r.exitCode} after ${Date.now() - started}ms`);
  });
  await step('files: write, read, list, remove', async () => {
    const path = `${home}/smoke/nested/hello.txt`;
    await provider.writeFile(ref, path, new Response('hi there').body!);
    const read = await new Response(await provider.readFile(ref, path)).text();
    check(read === 'hi there', `read back ${JSON.stringify(read)}`);
    const listed = await provider.listFiles(ref, `${home}/smoke/nested`);
    check(listed.some((e) => e.name === 'hello.txt' && e.type === 'file' && e.size === 8), `listing ${JSON.stringify(listed)}`);
    await provider.removeFile(ref, `${home}/smoke`);
    const gone = await provider.readFile(ref, path).then(
      () => false,
      () => true,
    );
    check(gone, 'file still readable after remove');
  });
  await step(
    'background process and port URL',
    async () => {
      await provider.startBackground(ref, { command: 'python3 -m http.server 8000', cwd: home, env: {} });
      const { url } = await provider.portUrl(ref, 8000);
      let status = 0;
      for (let i = 0; i < 15 && status !== 200; i++) {
        await new Promise((r) => setTimeout(r, 1_000));
        status = await fetch(url).then((res) => res.status, () => 0);
      }
      check(status === 200, `GET ${url} returned ${status}`);
      return url;
    },
    (url) => url,
  );
  await step('setTimeout (extend)', async () => {
    ref.expiresAt = new Date(Date.now() + (TIMEOUT_SECONDS + 300) * 1000);
    await provider.setTimeout(ref);
  });
  await step('kill', () => provider.kill(ref.providerSandboxId));
  await step('kill again is a no-op', () => provider.kill(ref.providerSandboxId));
  await step('isAlive after kill', async () => check(!(await provider.isAlive(ref.providerSandboxId)), 'still alive'));
}

console.log(`\n${provider.name} smoke test (${sandboxId})\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step.padEnd(38)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
