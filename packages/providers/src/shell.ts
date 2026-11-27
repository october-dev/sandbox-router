/** Quotes a string as a single POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A path that a command can't mistake for an option: a relative path starting with `-` gets
 * a `./` in front, which names the same file. For commands without `--` (find) or calls that
 * build a command line we don't control (provider SDK helpers).
 */
export function notAnOption(path: string): string {
  return path.startsWith('-') ? `./${path}` : path;
}

/** A name that is safe to splice unquoted into a shell command line as `NAME=value`. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
