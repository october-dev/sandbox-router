import type { SandboxData } from 'sandboxrouter';

export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Progress and details for people; kept off stdout so it never ends up in `$(...)`. */
export function info(message: string) {
  process.stderr.write(`${message}\n`);
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function usd(amount: number): string {
  if (amount === 0) return '$0';
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount < 0.0001) return '<$0.0001';
  return `$${amount.toPrecision(2).replace(/0+$/, '')}`;
}

/** `in 9m`, `3h ago`. */
export function relative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const span = duration(Math.abs(seconds));
  return seconds >= 0 ? `in ${span}` : `${span} ago`;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const m = Math.floor((seconds % 3600) / 60);
    return `${Math.floor(seconds / 3600)}h${m ? `${m}m` : ''}`;
  }
  return `${Math.floor(seconds / 86400)}d`;
}

export function resources(s: SandboxData): string {
  if (s.cpu === null || s.memoryMib === null) return s.size;
  return `${s.size} (${s.cpu} vCPU, ${gib(s.memoryMib)})`;
}

export function gib(mib: number): string {
  return mib % 1024 === 0 ? `${mib / 1024} GiB` : `${(mib / 1024).toFixed(1)} GiB`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function describeSandbox(s: SandboxData): string {
  const rows: Array<[string, string]> = [
    ['id', s.id],
    ['status', s.endReason ? `${s.status} (${s.endReason})` : s.status],
    ['provider', s.provider ?? '-'],
    ['size', resources(s)],
    ['price', `${usd(s.pricePerHourUsd)}/h`],
    ['cost', usd(s.costUsd)],
    ['created', `${s.createdAt} (${relative(s.createdAt)})`],
  ];
  if (s.endedAt) rows.push(['ended', `${s.endedAt} (${relative(s.endedAt)})`]);
  else rows.push(['expires', `${s.expiresAt} (${relative(s.expiresAt)})`]);
  if (s.homeDir) rows.push(['home', s.homeDir]);
  for (const [key, value] of Object.entries(s.metadata)) rows.push([`meta.${key}`, value]);
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n');
}
