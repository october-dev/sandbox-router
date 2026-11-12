export const SIZES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];

/** The resources each size requests. Every provider maps a size to exactly these. */
export const SIZE_SPECS: Record<Size, { cpu: number; memoryMib: number }> = {
  small: { cpu: 1, memoryMib: 1024 },
  medium: { cpu: 2, memoryMib: 4096 },
  large: { cpu: 4, memoryMib: 8192 },
};

export const PROVIDER_NAMES = ['e2b', 'daytona', 'daytona-vm', 'novita', 'modal-gvisor', 'modal-vm', 'vercel', 'boat'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Label put on every provider sandbox so it can be traced back to our sandbox id. */
export const SANDBOX_ID_LABEL = 'sandboxrouter_id';

/** Resources a provider reports for a running sandbox. Disk is null when the provider doesn't report it. */
export interface Resources {
  cpu: number;
  memoryMib: number;
  diskMib: number | null;
}

export interface CreatedSandbox extends Resources {
  providerSandboxId: string;
  homeDir: string;
  /** When the provider says the sandbox started (what it bills from), if it reports it. */
  startedAt: Date | null;
}

/** Identifies a live provider sandbox together with the deadline we hold it to. */
export interface SandboxRef {
  providerSandboxId: string;
  expiresAt: Date;
}

export interface ExecRequest {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Providers that support it wait for the returned promise, which applies backpressure. */
  onStdout: (chunk: string) => void | Promise<void>;
  onStderr: (chunk: string) => void | Promise<void>;
  /** Aborting kills the command, including when it is already aborted on entry. */
  signal: AbortSignal;
}

export interface ExecResult {
  /** Null when the command was killed before it exited (timeout or abort). */
  exitCode: number | null;
  timedOut: boolean;
}

export interface BackgroundRequest {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  modifiedAt: string | null;
}

export interface PortUrl {
  url: string;
  /** Null when the URL stays valid for the sandbox's whole life. */
  expiresAt: Date | null;
}

export interface TaggedSandbox {
  providerSandboxId: string;
  sandboxId: string;
}

export interface Provider {
  readonly name: ProviderName;
  /** Longest a sandbox may live on this provider, counted from creation. */
  readonly maxLifetimeSeconds: number;
  /**
   * False when the provider can't move a sandbox's deadline later after creation.
   * Such sandboxes can still be shortened (we kill them at the new deadline ourselves),
   * but never extended past the deadline they currently have.
   */
  readonly canExtendTimeout: boolean;
  /** Resources a sandbox of this size gets on this provider. */
  resources(size: Size): Resources;
  /** List price per hour, in micro-USD, for a sandbox with these resources. */
  ratePerHourMicros(resources: Resources): number;
  /**
   * Creates a sandbox that the provider itself destroys no earlier than `timeoutSeconds`
   * after its reported start; we kill it at that point ourselves.
   */
  create(input: { size: Size; timeoutSeconds: number; sandboxId: string }): Promise<CreatedSandbox>;
  /** Idempotent: succeeds when the sandbox is already gone. */
  kill(providerSandboxId: string): Promise<void>;
  /** Moves the provider-side deadline to no earlier than `ref.expiresAt`. */
  setTimeout(ref: SandboxRef): Promise<void>;
  /** All sandboxes on this provider that carry our sandbox id label and are not destroyed. */
  listTagged(): Promise<TaggedSandbox[]>;
  /** Asks the provider directly whether the sandbox still exists and can run. */
  isAlive(providerSandboxId: string): Promise<boolean>;
  exec(ref: SandboxRef, request: ExecRequest): Promise<ExecResult>;
  /** Starts a detached process and returns without waiting for it. */
  startBackground(ref: SandboxRef, request: BackgroundRequest): Promise<void>;
  readFile(ref: SandboxRef, path: string): Promise<ReadableStream<Uint8Array>>;
  /** Creates parent directories and overwrites existing files. */
  writeFile(ref: SandboxRef, path: string, data: ReadableStream<Uint8Array>): Promise<void>;
  listFiles(ref: SandboxRef, path: string): Promise<FileEntry[]>;
  /** Removes a file or a directory recursively. */
  removeFile(ref: SandboxRef, path: string): Promise<void>;
  portUrl(ref: SandboxRef, port: number): Promise<PortUrl>;
}
