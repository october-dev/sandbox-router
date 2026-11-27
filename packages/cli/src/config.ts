import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, UsageError } from './args.ts';

/** Saved logins, one API key per server, and the server used when none is given. */
export interface Config {
  default?: string;
  servers: Record<string, { apiKey: string }>;
}

export type Env = Record<string, string | undefined>;

/** `$SANDBOXROUTER_CONFIG`, else `$XDG_CONFIG_HOME/sandboxrouter/config.json` (`~/.config` by default; `%APPDATA%` on Windows). */
export function configPath(env: Env): string {
  if (env.SANDBOXROUTER_CONFIG) return env.SANDBOXROUTER_CONFIG;
  const base = env.XDG_CONFIG_HOME || (process.platform === 'win32' && env.APPDATA) || join(homedir(), '.config');
  return join(base, 'sandboxrouter', 'config.json');
}

export function readConfig(path: string): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} };
    throw error;
  }
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    process.stderr.write(`warning: ${path} can be read by other users; run: chmod 600 ${path}\n`);
  }
  try {
    const parsed = JSON.parse(text) as Partial<Config>;
    return { default: parsed.default, servers: parsed.servers ?? {} };
  } catch {
    throw new CliError(`${path} is not valid JSON`, 'Delete it and run `sandboxrouter login` again.');
  }
}

/** Writes the file readable by its owner only (0600), in a directory only they can list (0700). */
export function writeConfig(path: string, config: Config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function removeConfig(path: string) {
  rmSync(path, { force: true });
}

/** `http://host:port/prefix` with no trailing slash, query or fragment. */
export function normalizeUrl(value: string, command?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(`"${value}" is not a URL; include the scheme, e.g. http://localhost:8787`, command);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`"${value}" must start with http:// or https://`, command);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function isLocal(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

export interface Credentials {
  baseUrl: string;
  apiKey: string;
  /** Where the key came from, for `status` and error hints. */
  keySource: 'flag' | 'env' | 'config';
}

/**
 * The server: `--base-url`, else SANDBOXROUTER_BASE_URL, else the saved default.
 * The key: `--api-key`, else SANDBOXROUTER_API_KEY, else the one saved for that server.
 * A saved key is only ever sent to the server it was saved for.
 */
export function resolveServer(flags: { 'base-url'?: string }, env: Env, config: Config): string | undefined {
  const raw = flags['base-url'] ?? (env.SANDBOXROUTER_BASE_URL || undefined) ?? config.default;
  return raw === undefined ? undefined : normalizeUrl(raw);
}

export function resolveCredentials(flags: { 'base-url'?: string; 'api-key'?: string }, env: Env, config: Config): Credentials {
  const baseUrl = resolveServer(flags, env, config);
  if (!baseUrl) {
    throw new CliError(
      'No server configured',
      'Run `sandboxrouter login <url>`, or set SANDBOXROUTER_BASE_URL and SANDBOXROUTER_API_KEY.',
    );
  }
  if (flags['api-key']) return { baseUrl, apiKey: flags['api-key'], keySource: 'flag' };
  if (env.SANDBOXROUTER_API_KEY) return { baseUrl, apiKey: env.SANDBOXROUTER_API_KEY, keySource: 'env' };
  const saved = config.servers[baseUrl];
  if (saved) return { baseUrl, apiKey: saved.apiKey, keySource: 'config' };
  throw new CliError(`Not logged in to ${baseUrl}`, `Run \`sandboxrouter login ${baseUrl}\`, or set SANDBOXROUTER_API_KEY.`);
}
