import type { ParseArgsOptionsConfig } from 'node:util';
import {
  type CreateSandboxOptions,
  type ProviderInfo,
  type ProviderName,
  type SandboxData,
  SandboxRouter,
  SandboxRouterError,
  type SandboxStatus,
} from 'sandboxrouter';
import { CliError, UsageError, oneOf, parse, parseDuration, parsePairs, positiveInt, type Parsed } from './args.ts';
import { configPath, isLocal, normalizeUrl, readConfig, removeConfig, resolveCredentials, resolveServer, writeConfig, type Env } from './config.ts';
import { copy, parseLocation } from './cp.ts';
import { browserLogin, keyFromSecret, readSecret, readStdin, type LoginResult } from './login.ts';
import { bytes, describeSandbox, duration, info, printJson, relative, resources, table, usd } from './output.ts';

const SIZES = ['small', 'medium', 'large'] as const;
const PRESETS = ['cheap', 'fast'] as const;
const PROVIDERS = ['e2b', 'daytona', 'daytona-vm', 'modal-gvisor', 'modal-vm', 'vercel', 'novita', 'boat'] as const satisfies readonly ProviderName[];
const STATUSES = ['creating', 'running', 'ended', 'failed'] as const satisfies readonly SandboxStatus[];

export interface Context {
  env: Env;
  fetch: typeof fetch;
}

export interface Command {
  name: string;
  summary: string;
  help: string;
  options?: ParseArgsOptionsConfig;
  /** Option parsing stops after this many positionals; the rest is passed on as is. */
  stopAfter?: number;
  run(args: Parsed, ctx: Context): Promise<number | void>;
}

function client(args: Parsed, ctx: Context): SandboxRouter {
  const { baseUrl, apiKey } = resolveCredentials(flags(args), ctx.env, readConfig(configPath(ctx.env)));
  return new SandboxRouter({ apiKey, baseUrl, fetch: ctx.fetch });
}

function flags(args: Parsed) {
  return { 'base-url': args.values['base-url'] as string | undefined, 'api-key': args.values['api-key'] as string | undefined };
}

function json(args: Parsed): boolean {
  return args.values.json === true;
}

function need(args: Parsed, command: string, names: string[], max = names.length): string[] {
  if (args.positionals.length < names.length) {
    throw new UsageError(`Missing ${names.slice(args.positionals.length).map((n) => `<${n}>`).join(' ')}`, command);
  }
  if (args.positionals.length > max) throw new UsageError(`Unexpected argument "${args.positionals[max]}"`, command);
  return args.positionals;
}

const login: Command = {
  name: 'login',
  summary: 'Log in to a server and save the API key',
  help: `Usage: sandboxrouter login [url] [options]

Saves an API key for a server in the config file (readable only by you), and makes
that server the default. Servers that support browser login show a code to approve
in your browser. Otherwise paste an API key (sr_...), or a self-hosted server's
ADMIN_TOKEN to create a new key with it (the admin token itself is not saved).

The url defaults to SANDBOXROUTER_BASE_URL or the current default server.

Options:
  --with-key      Read the API key or admin token from stdin instead of asking
  --no-browser    Don't open a browser for browser login

Examples:
  sandboxrouter login http://localhost:8787
  echo "$SANDBOXROUTER_API_KEY" | sandboxrouter login https://sandboxes.example.com --with-key`,
  options: { 'with-key': { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
  async run(args, ctx) {
    const [url] = need(args, 'login', [], 1);
    const path = configPath(ctx.env);
    const config = readConfig(path);
    const raw = url ?? resolveServer(flags(args), ctx.env, config);
    if (!raw) throw new UsageError('Give the server URL, e.g. sandboxrouter login http://localhost:8787', 'login');
    const baseUrl = normalizeUrl(raw, 'login');
    if (baseUrl.startsWith('http:') && !isLocal(baseUrl)) {
      info(`warning: ${baseUrl} is not HTTPS, so the key is sent unencrypted. Put a TLS proxy in front of the server.`);
    }

    let result: LoginResult | undefined;
    if (args.values['with-key']) {
      const secret = await readStdin();
      if (!secret) throw new UsageError('No key on stdin', 'login');
      result = await keyFromSecret(baseUrl, secret, ctx.fetch);
    } else {
      result = await browserLogin(baseUrl, {
        fetch: ctx.fetch,
        openBrowser: !args.values['no-browser'] && process.stdout.isTTY === true,
      });
      if (!result) {
        if (!process.stdin.isTTY) {
          throw new CliError(
            `${baseUrl} has no browser login`,
            'Pipe an API key (or the admin token) in with --with-key: echo "$KEY" | sandboxrouter login <url> --with-key',
          );
        }
        const secret = await readSecret(`API key for ${baseUrl} (or the server's ADMIN_TOKEN to create one): `);
        if (!secret) throw new CliError('No key entered');
        result = await keyFromSecret(baseUrl, secret, ctx.fetch);
      }
    }

    const latest = readConfig(path);
    latest.servers[baseUrl] = { apiKey: result.apiKey };
    latest.default = baseUrl;
    writeConfig(path, latest);
    if (json(args)) {
      printJson({ baseUrl, via: result.via, email: result.email ?? null, configPath: path });
      return;
    }
    const who = result.email ? ` as ${result.email}` : '';
    const how = result.via === 'admin_token' ? ' (created a new API key with the admin token)' : '';
    info(`Logged in to ${baseUrl}${who}${how}. Key saved to ${path}`);
  },
};

const logout: Command = {
  name: 'logout',
  summary: 'Remove a saved API key',
  help: `Usage: sandboxrouter logout [url] [--all]

Removes the key saved for a server (the default server if no url is given). The key
itself keeps working until it is revoked on the server.

Options:
  --all    Remove every saved key (deletes the config file)`,
  options: { all: { type: 'boolean' } },
  async run(args, ctx) {
    const [url] = need(args, 'logout', [], 1);
    const path = configPath(ctx.env);
    if (args.values.all) {
      removeConfig(path);
      info(`Removed ${path}`);
      return;
    }
    const config = readConfig(path);
    const baseUrl = url ? normalizeUrl(url, 'logout') : resolveServer(flags(args), ctx.env, config);
    if (!baseUrl || !config.servers[baseUrl]) {
      info(baseUrl ? `Not logged in to ${baseUrl}` : 'Not logged in');
      return;
    }
    delete config.servers[baseUrl];
    if (config.default === baseUrl) config.default = Object.keys(config.servers)[0];
    if (Object.keys(config.servers).length === 0) removeConfig(path);
    else writeConfig(path, config);
    info(`Logged out of ${baseUrl}. The key still works until it is revoked on the server.`);
  },
};

const status: Command = {
  name: 'status',
  summary: 'Show which server and key are in use, and check them',
  help: `Usage: sandboxrouter status

Shows the server and where the API key comes from (--api-key, SANDBOXROUTER_API_KEY or
the config file), and checks that the server accepts the key.`,
  async run(args, ctx) {
    const path = configPath(ctx.env);
    const credentials = resolveCredentials(flags(args), ctx.env, readConfig(path));
    const router = new SandboxRouter({ apiKey: credentials.apiKey, baseUrl: credentials.baseUrl, fetch: ctx.fetch });
    const page = await router.sandboxes.list({ status: 'running', limit: 200 });
    // Only servers with billing have an account balance.
    const account = await router.account().catch((error: unknown) => {
      if (error instanceof SandboxRouterError && error.status === 404) return null;
      throw error;
    });
    const source = { flag: '--api-key', env: 'SANDBOXROUTER_API_KEY', config: path }[credentials.keySource];
    if (json(args)) {
      printJson({ baseUrl: credentials.baseUrl, keySource: credentials.keySource, runningSandboxes: page.data.length, account });
      return;
    }
    const lines = [
      `server   ${credentials.baseUrl}`,
      `key      ${credentials.apiKey.slice(0, 7)}... (from ${source})`,
      `running  ${page.data.length}${page.nextCursor ? '+' : ''} sandbox${page.data.length === 1 ? '' : 'es'}`,
    ];
    if (account) lines.push(`account  ${account.email}`, `balance  ${usd(account.availableUsd)} available (${usd(account.heldUsd)} held)`);
    process.stdout.write(`${lines.join('\n')}\n`);
  },
};

const create: Command = {
  name: 'create',
  summary: 'Create a sandbox and print its id',
  help: `Usage: sandboxrouter create [options]

Creates a sandbox, waits until it is running and prints its id, so it can be captured:
  id=$(sandboxrouter create --size medium --timeout 30m)

Options:
  --size <size>          small (1 vCPU, 1 GiB), medium (2, 4 GiB) or large (4, 8 GiB). Default small
  --preset <preset>      cheap (lowest price) or fast (quickest recent creates). Default cheap
  --provider <name>      Use this provider instead of choosing one: ${PROVIDERS.join(', ')}
  --timeout <duration>   Kill it after this long: seconds, or 90s, 10m, 1h. Default 5m
  --metadata <key=value> Label it (repeatable)
  --json                 Print the sandbox as JSON`,
  options: {
    size: { type: 'string', short: 's' },
    preset: { type: 'string', short: 'p' },
    provider: { type: 'string' },
    timeout: { type: 'string', short: 't' },
    metadata: { type: 'string', short: 'm', multiple: true },
  },
  async run(args, ctx) {
    need(args, 'create', [], 0);
    const v = args.values;
    const options: CreateSandboxOptions = {
      size: oneOf(v.size as string | undefined, SIZES, '--size', 'create'),
      preset: oneOf(v.preset as string | undefined, PRESETS, '--preset', 'create'),
      provider: oneOf(v.provider as string | undefined, PROVIDERS, '--provider', 'create'),
      timeout: v.timeout === undefined ? undefined : parseDuration(v.timeout as string, '--timeout', 'create'),
      metadata: parsePairs(v.metadata as string[] | undefined, '--metadata', 'create'),
    };
    const router = client(args, ctx);
    if (!json(args) && process.stderr.isTTY) {
      info(`Creating a ${options.size ?? 'small'} sandbox${options.provider ? ` on ${options.provider}` : ` (${options.preset ?? 'cheap'})`}...`);
    }
    const sandbox = await router.sandboxes.create(options);
    if (json(args)) return printJson(sandbox.data);
    const s = sandbox.data;
    info(`Created ${s.id} on ${s.provider}: ${resources(s)}, ${usd(s.pricePerHourUsd)}/h, expires ${relative(s.expiresAt)}`);
    process.stdout.write(`${s.id}\n`);
  },
};

const list: Command = {
  name: 'list',
  summary: 'List sandboxes (running ones by default)',
  help: `Usage: sandboxrouter list [options]

Lists running sandboxes, newest first.

Options:
  --all               Include ended and failed sandboxes
  --status <status>   Only this status: ${STATUSES.join(', ')}
  --limit <n>         At most this many (default: every running one, or 20 with --all/--status)
  -q, --quiet         Print only ids, e.g. sandboxrouter list -q | xargs sandboxrouter kill
  --json              Print JSON`,
  options: {
    all: { type: 'boolean', short: 'a' },
    status: { type: 'string' },
    limit: { type: 'string', short: 'n' },
    quiet: { type: 'boolean', short: 'q' },
  },
  async run(args, ctx) {
    need(args, 'list', [], 0);
    const v = args.values;
    const statusFilter = v.all ? undefined : (oneOf(v.status as string | undefined, STATUSES, '--status', 'list') ?? 'running');
    const everyRunning = !v.all && v.status === undefined && v.limit === undefined;
    const limit = v.limit === undefined ? (everyRunning ? Infinity : 20) : positiveInt(v.limit as string, '--limit', 'list');
    const router = client(args, ctx);
    const sandboxes: SandboxData[] = [];
    let before: string | undefined;
    do {
      const page = await router.sandboxes.list({ status: statusFilter, limit: Math.min(200, limit - sandboxes.length), before });
      sandboxes.push(...page.data);
      before = page.nextCursor ?? undefined;
    } while (before && sandboxes.length < limit);

    if (json(args)) return printJson(sandboxes);
    if (v.quiet) {
      if (sandboxes.length) process.stdout.write(`${sandboxes.map((s) => s.id).join('\n')}\n`);
      return;
    }
    if (!sandboxes.length) {
      info(statusFilter === 'running' ? 'No running sandboxes' : 'No sandboxes');
      return;
    }
    const rows = sandboxes.map((s) => [
      s.id,
      s.status,
      s.provider ?? '-',
      s.size,
      usd(s.costUsd),
      relative(s.createdAt),
      s.status === 'running' ? relative(s.expiresAt) : (s.endReason ?? '-'),
    ]);
    process.stdout.write(`${table(['ID', 'STATUS', 'PROVIDER', 'SIZE', 'COST', 'CREATED', 'EXPIRES'], rows)}\n`);
  },
};

const get: Command = {
  name: 'get',
  summary: 'Show a sandbox',
  help: `Usage: sandboxrouter get <id> [--json]

Shows a sandbox's status, provider, resources, price, cost so far and deadline.`,
  async run(args, ctx) {
    const [id] = need(args, 'get', ['id']);
    const sandbox = await client(args, ctx).sandboxes.get(id!);
    if (json(args)) return printJson(sandbox.data);
    process.stdout.write(`${describeSandbox(sandbox.data)}\n`);
  },
};

/** One argument is run as a shell script; several are quoted so each reaches the command as one argument. */
export function commandLine(argv: string[]): string {
  if (argv.length === 1) return argv[0]!;
  return argv.map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ');
}

const exec: Command = {
  name: 'exec',
  summary: 'Run a command in a sandbox, streaming its output',
  stopAfter: 1,
  help: `Usage: sandboxrouter exec <id> [options] [--] <command...>

Runs the command with bash -lc in the sandbox, streams its output and exits with its
exit code (124 if it timed out). Ctrl-C stops it.

One argument is run as a shell script, so pipes and variables work inside quotes:
  sandboxrouter exec sbx_abc123 'cd app && npm test | tail -n 20'
Several arguments are passed to the command as they are, one argument each:
  sandboxrouter exec sbx_abc123 python3 -c "print(6 * 7)"

Options must come before the command:
  --cwd <dir>            Working directory (relative paths start at the sandbox's home)
  --env <KEY=value>      Set an environment variable (repeatable)
  --timeout <duration>   Kill the command after this long (default 60s, at most 1h)
  --background           Start it and return at once; its output is discarded
  --json                 Wait, then print exitCode, stdout, stderr and more as JSON`,
  options: {
    cwd: { type: 'string' },
    env: { type: 'string', short: 'e', multiple: true },
    timeout: { type: 'string', short: 't' },
    background: { type: 'boolean', short: 'b' },
  },
  async run(args, ctx) {
    const [id] = need(args, 'exec', ['id'], 1);
    if (!args.rest.length) throw new UsageError('Missing <command>', 'exec');
    const command = commandLine(args.rest);
    const v = args.values;
    const options = {
      cwd: v.cwd as string | undefined,
      env: parsePairs(v.env as string[] | undefined, '--env', 'exec'),
      timeout: v.timeout === undefined ? undefined : parseDuration(v.timeout as string, '--timeout', 'exec'),
    };
    const router = client(args, ctx);
    const sandbox = await router.sandboxes.get(id!);

    if (v.background) {
      if (options.timeout !== undefined) throw new UsageError('--timeout does not apply to --background commands', 'exec');
      await sandbox.startBackground(command, { cwd: options.cwd, env: options.env });
      if (json(args)) printJson({ started: true });
      return;
    }

    const controller = new AbortController();
    let interrupted = false;
    const onSigint = () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      controller.abort();
    };
    process.on('SIGINT', onSigint);
    try {
      if (json(args)) {
        const result = await sandbox.exec(command, { ...options, signal: controller.signal });
        printJson(result);
        return exitStatus(result.exitCode, result.timedOut);
      }
      for await (const event of sandbox.execStream(command, { ...options, signal: controller.signal })) {
        if (event.type === 'stdout') await write(process.stdout, event.data);
        else if (event.type === 'stderr') await write(process.stderr, event.data);
        else {
          if (event.timedOut) info(`error: the command timed out after ${duration(options.timeout ?? 60)}`);
          return exitStatus(event.exitCode, event.timedOut);
        }
      }
    } catch (error) {
      if (interrupted) return 130;
      throw error;
    } finally {
      process.off('SIGINT', onSigint);
    }
  },
};

function exitStatus(exitCode: number | null, timedOut: boolean): number {
  if (timedOut) return 124;
  return exitCode ?? 1;
}

/** Writes and waits when the pipe is full, so a slow reader slows the stream instead of buffering it all. */
function write(stream: NodeJS.WriteStream, data: string): Promise<void> | void {
  if (!stream.write(data)) return new Promise((resolve) => stream.once('drain', resolve));
}

const cp: Command = {
  name: 'cp',
  summary: 'Copy files to or from a sandbox',
  help: `Usage: sandboxrouter cp [-r] <source> <destination>

Copies a file between this machine and a sandbox. Sandbox paths look like
sbx_abc123:path; relative ones start at the sandbox's home directory. Use - for
stdin or stdout.

  sandboxrouter cp ./main.py sbx_abc123:app/main.py   upload (parent directories are created)
  sandboxrouter cp ./main.py sbx_abc123:app/          into a directory: app/main.py
  sandboxrouter cp sbx_abc123:app/out.json .          download into the current directory
  sandboxrouter cp -r ./src sbx_abc123:app            upload a directory's contents to app/
  sandboxrouter cp -r sbx_abc123:app/dist ./dist      download a directory
  tar cz . | sandboxrouter cp - sbx_abc123:code.tgz   from stdin
  sandboxrouter cp sbx_abc123:log.txt - | less        to stdout

Each file is up to 100 MiB. File modes (such as the executable bit) are not kept.

Options:
  -r, --recursive   Copy directories
  --json            Print the files copied as JSON`,
  options: { recursive: { type: 'boolean', short: 'r' } },
  async run(args, ctx) {
    const [source, destination] = need(args, 'cp', ['source', 'destination']);
    const router = client(args, ctx);
    const result = await copy(router, parseLocation(source!), parseLocation(destination!), { recursive: args.values.recursive === true });
    if (json(args)) return printJson(result);
    for (const path of result.skipped) info(`skipped ${path} (not a regular file, or outside the directory)`);
    if (destination === '-') return;
    const total = result.files.reduce((sum, f) => sum + f.bytes, 0);
    const what = result.files.length === 1 ? result.files[0]!.to : `${result.files.length} files`;
    info(`Copied ${what} (${bytes(total)})`);
  },
};

const url: Command = {
  name: 'url',
  summary: 'Print a public URL for a port in a sandbox',
  help: `Usage: sandboxrouter url <id> <port> [--json]

Prints an HTTPS URL that reaches a server listening on <port> inside the sandbox.
Some providers only expose certain ports (see the README's provider table).

  sandboxrouter exec sbx_abc123 --background 'python3 -m http.server 8000'
  curl "$(sandboxrouter url sbx_abc123 8000)"`,
  async run(args, ctx) {
    const [id, port] = need(args, 'url', ['id', 'port']);
    const result = await (await client(args, ctx).sandboxes.get(id!)).portUrl(positiveInt(port!, '<port>', 'url', 65535));
    if (json(args)) return printJson(result);
    process.stdout.write(`${result.url}\n`);
    if (result.expiresAt) info(`The URL expires ${relative(result.expiresAt)} (${result.expiresAt})`);
  },
};

const timeout: Command = {
  name: 'timeout',
  summary: 'Change when a sandbox is killed',
  help: `Usage: sandboxrouter timeout <id> <duration> [--json]

Sets the sandbox to be killed <duration> from now (seconds, or 90s, 10m, 1h), whether
that is sooner or later than its current deadline.

  sandboxrouter timeout sbx_abc123 1h`,
  async run(args, ctx) {
    const [id, value] = need(args, 'timeout', ['id', 'duration']);
    const seconds = parseDuration(value!, '<duration>', 'timeout');
    const sandbox = await client(args, ctx).sandboxes.get(id!);
    const data = await sandbox.setTimeout(seconds);
    if (json(args)) return printJson(data);
    info(`${data.id} now expires ${relative(data.expiresAt)} (${data.expiresAt})`);
  },
};

const kill: Command = {
  name: 'kill',
  summary: 'Kill sandboxes',
  help: `Usage: sandboxrouter kill <id...> [--json]

Kills one or more sandboxes and prints what each cost. Killing an ended sandbox is
not an error.

  sandboxrouter list -q | xargs sandboxrouter kill`,
  async run(args, ctx) {
    if (!args.positionals.length) throw new UsageError('Missing <id>', 'kill');
    const router = client(args, ctx);
    const results: SandboxData[] = [];
    let failed = 0;
    for (const id of args.positionals) {
      try {
        const data = await (await router.sandboxes.get(id)).kill();
        results.push(data);
        if (!json(args)) info(`Killed ${data.id} (cost ${usd(data.costUsd)})`);
      } catch (error) {
        if (args.positionals.length === 1) throw error;
        failed++;
        info(`error: ${id}: ${(error as Error).message}`);
      }
    }
    if (json(args)) printJson(results);
    return failed ? 1 : 0;
  },
};

const providers: Command = {
  name: 'providers',
  summary: 'List providers, prices and recent create speed',
  help: `Usage: sandboxrouter providers [--json]

Lists the providers the server offers, their price per hour for each size, the longest
timeout they allow, and how quickly they have been creating sandboxes.`,
  async run(args, ctx) {
    need(args, 'providers', [], 0);
    const config = readConfig(configPath(ctx.env));
    const baseUrl = resolveServer(flags(args), ctx.env, config);
    if (!baseUrl) throw new CliError('No server configured', 'Run `sandboxrouter login <url>`, or pass --base-url.');
    // Needs no key, so it works before logging in.
    const response = await ctx.fetch(`${baseUrl}/v1/providers`);
    if (!response.ok) throw new SandboxRouterError(response.status, 'http_error', `HTTP ${response.status} from ${baseUrl}/v1/providers`);
    const { data } = (await response.json()) as { data: ProviderInfo[] };
    if (json(args)) return printJson(data);
    if (!data.length) return info('The server has no providers configured');
    const price = (p: ProviderInfo, size: string) => {
      const s = p.sizes.find((x) => x.size === size);
      return s ? `${usd(s.pricePerHourUsd)}/h` : '-';
    };
    const rows = data.map((p) => [
      p.name,
      price(p, 'small'),
      price(p, 'medium'),
      price(p, 'large'),
      duration(p.maxTimeoutSeconds),
      p.health.medianCreateMs === null ? '-' : `${(p.health.medianCreateMs / 1000).toFixed(1)}s`,
      p.health.failing ? 'failing' : 'ok',
    ]);
    process.stdout.write(`${table(['PROVIDER', 'SMALL', 'MEDIUM', 'LARGE', 'MAX TIMEOUT', 'CREATE', 'HEALTH'], rows)}\n`);
  },
};

export const COMMANDS: Command[] = [login, logout, status, create, list, get, exec, cp, url, timeout, kill, providers];
