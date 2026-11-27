/** Quotes a string as a single POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A name that is safe to splice unquoted into a shell command line as `NAME=value`. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
