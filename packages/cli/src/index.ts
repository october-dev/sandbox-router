#!/usr/bin/env node
import { createRequire } from 'node:module';
import { SandboxRouterError } from 'sandboxrouter';
import { CliError, UsageError, parse } from './args.ts';
import { COMMANDS, type Context } from './commands.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const HELP = `sandboxrouter: create cloud sandboxes on any provider, run commands, copy files.

Usage: sandboxrouter <command> [options]

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(11)}${c.summary}`).join('\n')}

Options for every command:
  --base-url <url>   Server to use (or SANDBOXROUTER_BASE_URL; default: the last one you logged in to)
  --api-key <key>    API key to use (or SANDBOXROUTER_API_KEY; default: the one saved by login)
  --json             Print JSON for scripts
  -h, --help         Show help for a command
  --version          Print the version

Get started:
  sandboxrouter login http://localhost:8787
  id=$(sandboxrouter create --size small --timeout 10m)
  sandboxrouter cp -r ./app $id:app
  sandboxrouter exec $id 'cd app && npm install && npm test'
  sandboxrouter kill $id

Run 'sandboxrouter <command> --help' for more.`;

async function main(argv: string[], ctx: Context): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
    const topic = name === 'help' ? COMMANDS.find((c) => c.name === rest[0]) : undefined;
    process.stdout.write(`${topic ? topic.help : HELP}\n`);
    return 0;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === (ALIASES[name] ?? name));
  if (!command) {
    const near = COMMANDS.find((c) => distance(c.name, name) <= 2);
    throw new UsageError(`Unknown command "${name}"${near ? `. Did you mean "${near.name}"?` : ''}`);
  }
  const args = parse(command.name, rest, command.options ?? {}, command.stopAfter);
  if (args.values.help) {
    process.stdout.write(`${command.help}\n`);
    return 0;
  }
  return (await command.run(args, ctx)) ?? 0;
}

const ALIASES: Record<string, string> = { ls: 'list', run: 'exec', rm: 'kill' };

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function report(error: unknown, ctx: Context, asJson: boolean): number {
  const fail = (code: string, message: string, hint?: string, status?: number) => {
    if (asJson) {
      process.stderr.write(`${JSON.stringify({ error: { code, message, ...(status ? { status } : {}), ...(hint ? { hint } : {}) } })}\n`);
    } else {
      process.stderr.write(`error: ${message}\n${hint ? `${hint}\n` : ''}`);
    }
  };
  if (error instanceof UsageError) {
    fail('usage', error.message, `Run 'sandboxrouter ${error.command ? `${error.command} ` : ''}--help' for usage.`);
    return 2;
  }
  if (error instanceof CliError) {
    fail('error', error.message, error.hint);
    return 1;
  }
  if (error instanceof SandboxRouterError) {
    fail(error.code, error.message, hintFor(error, ctx), error.status || undefined);
    return 1;
  }
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (error instanceof TypeError && error.message === 'fetch failed') {
    fail(
      'network_error',
      `Could not reach the server (${cause?.code ?? cause?.message ?? 'network error'})`,
      'Check the URL (--base-url, SANDBOXROUTER_BASE_URL or `sandboxrouter status`) and that the server is running.',
    );
    return 1;
  }
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') return 0;
  fail('internal', error instanceof Error ? (error.stack ?? error.message) : String(error));
  return 1;
}

function hintFor(error: SandboxRouterError, ctx: Context): string | undefined {
  switch (error.code) {
    case 'unauthorized':
      return ctx.env.SANDBOXROUTER_API_KEY
        ? 'Check SANDBOXROUTER_API_KEY: it is used instead of the key saved by login.'
        : 'Run `sandboxrouter login` to save a new API key.';
    case 'insufficient_funds':
      return 'Add funds to your balance, or use a smaller size or shorter timeout.';
    case 'no_provider':
      return 'See `sandboxrouter providers` for what this server offers.';
    case 'limit_exceeded':
      return 'Kill sandboxes you no longer need (`sandboxrouter list`), or wait and retry.';
    case 'sandbox_not_running':
      return 'See `sandboxrouter get <id>` for how it ended.';
    case 'stream_closed':
      return 'The connection dropped; the command may still be running until its timeout.';
    default:
      return undefined;
  }
}

const ctx: Context = { env: process.env, fetch: globalThis.fetch.bind(globalThis) };
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  // The reader went away (e.g. `| head`); stop quietly like other command line tools.
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
const argv = process.argv.slice(2);
main(argv, ctx).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.exitCode = report(error, ctx, argv.includes('--json'));
  },
);
