export type Size = 'small' | 'medium' | 'large';
export type Preset = 'cheap' | 'fast';
export type ProviderName = 'e2b' | 'daytona';
export type SandboxStatus = 'creating' | 'running' | 'ended' | 'failed';
export type EndReason = 'killed' | 'expired' | 'lost' | 'create_failed';

export interface SandboxData {
  id: string;
  status: SandboxStatus;
  size: Size;
  preset: Preset | null;
  provider: ProviderName | null;
  cpu: number | null;
  memoryMib: number | null;
  diskMib: number | null;
  /** Relative paths in exec and file calls resolve against this. */
  homeDir: string | null;
  pricePerHourUsd: number;
  /** Final cost once ended; cost so far while running. */
  costUsd: number;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: EndReason | null;
  metadata: Record<string, string>;
}

export interface CreateSandboxOptions {
  /** small: 1 vCPU / 1 GiB, medium: 2 vCPU / 4 GiB, large: 4 vCPU / 8 GiB. Default small. */
  size?: Size;
  /** `cheap` picks the lowest price, `fast` the lowest recent create latency. Default cheap. */
  preset?: Preset;
  /** Pin a provider instead of routing. */
  provider?: ProviderName;
  /** Seconds until the sandbox is killed, 60 to 86400. Default 300. */
  timeout?: number;
  metadata?: Record<string, string>;
}

export interface ExecOptions {
  /** Working directory, absolute or relative to the home directory. */
  cwd?: string;
  env?: Record<string, string>;
  /** Seconds before the command is killed, 1 to 3600. Default 60. */
  timeout?: number;
  /** Aborting kills the command. */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Null when the command was killed by its timeout. */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** True when output beyond 10 MiB per stream was dropped. */
  truncated: boolean;
  durationMs: number;
}

export type ExecEvent =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'exit'; exitCode: number | null; timedOut: boolean; durationMs: number };

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  modifiedAt: string | null;
}

export interface PortUrl {
  url: string;
  /** When the URL stops working; null if it lasts as long as the sandbox. */
  expiresAt: string | null;
}

export interface Account {
  email: string;
  balanceUsd: number;
  heldUsd: number;
  availableUsd: number;
  runningSandboxes: number;
}

export interface ProviderInfo {
  name: ProviderName;
  maxTimeoutSeconds: number;
  sizes: Array<{ size: Size; cpu: number; memoryMib: number; diskMib: number | null; pricePerHourUsd: number }>;
  health: { medianCreateMs: number | null; successRate: number | null; failing: boolean };
}

export interface ListSandboxesOptions {
  status?: SandboxStatus;
  limit?: number;
  /** `nextCursor` from the previous page. */
  before?: string;
}

export interface SandboxPage {
  data: SandboxData[];
  nextCursor: string | null;
}
