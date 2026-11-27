import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

/** A mistake in how the CLI was called. Exits with status 2 and points at `--help`. */
export class UsageError extends Error {
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

/** An error worth showing as is, without a stack trace. */
export class CliError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}

export const GLOBAL_OPTIONS = {
  'base-url': { type: 'string' },
  'api-key': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  /** Everything after the positional that ends option parsing (or after `--`). */
  rest: string[];
}

/**
 * Parses options and positionals. With `stopAfter`, option parsing ends after that many
 * positionals (or at `--`), and the remaining arguments are returned untouched in `rest`,
 * so `exec <id> ls -la` passes `-la` to the command.
 */
export function parse(command: string, argv: string[], options: ParseArgsOptionsConfig, stopAfter?: number): Parsed {
  const config = { ...GLOBAL_OPTIONS, ...options };
  let end = argv.length;
  let rest: string[] = [];
  let seen = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      end = i;
      rest = argv.slice(i + 1);
      break;
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (!arg.includes('=') && takesValue(config, arg)) i++;
      continue;
    }
    if (stopAfter !== undefined && ++seen > stopAfter) {
      end = i;
      rest = argv.slice(i);
      break;
    }
  }
  try {
    const { values, positionals } = parseArgs({ args: argv.slice(0, end), options: config, allowPositionals: true, strict: true });
    return { values: values as Parsed['values'], positionals, rest };
  } catch (error) {
    throw new UsageError((error as Error).message.replace(/\. To specify a positional argument.*$/s, ''), command);
  }
}

function takesValue(config: ParseArgsOptionsConfig, arg: string): boolean {
  if (arg.startsWith('--')) return config[arg.slice(2)]?.type === 'string';
  // A short flag, possibly bundled with others (-qa): only the last one can take a value.
  const short = arg.slice(-1);
  return arg.length === 2 && Object.values(config).some((o) => o.short === short && o.type === 'string');
}

/** `600`, `90s`, `10m`, `1h`, `1h30m` → seconds. */
export function parseDuration(value: string, what: string, command: string): number {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value.trim());
  if (!value.trim() || !match) throw new UsageError(`${what} must be a number of seconds or a duration like 90s, 10m or 1h (got "${value}")`, command);
  const [, h = '0', m = '0', s = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/** `KEY=value` pairs (repeatable options) → an object. */
export function parsePairs(values: string[] | undefined, what: string, command: string): Record<string, string> | undefined {
  if (!values?.length) return undefined;
  const result: Record<string, string> = {};
  for (const pair of values) {
    const at = pair.indexOf('=');
    if (at <= 0) throw new UsageError(`${what} must look like KEY=value (got "${pair}")`, command);
    result[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return result;
}

export function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], what: string, command: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`${what} must be one of ${allowed.join(', ')} (got "${value}")`, command);
  }
  return value as T;
}

export function positiveInt(value: string, what: string, command: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > max) throw new UsageError(`${what} must be a whole number from 1 to ${max} (got "${value}")`, command);
  return n;
}
