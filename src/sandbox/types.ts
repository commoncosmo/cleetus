export interface ExecOptions {
  /** Working directory for the command. Sandboxes default it to the project dir. */
  cwd?: string;
  /** Kill the command after this many ms. Undefined means no timeout. */
  timeoutMs?: number;
  /** Written to the child's stdin (UTF-8). Undefined → stdin is ignored (current behavior). */
  stdin?: string;
  /** Additional environment variables for the child. Existing process variables are preserved. */
  env?: Record<string, string | undefined>;
  /** Required: every sandboxed command must be cancellable. */
  signal: AbortSignal;
  /** Host-sandbox defense for model-authored shell commands: make `.git` and `.cleetus`
   * read-only even though the rest of the project is writable. Trusted Git/checkpoint tools omit
   * this flag. Unsupported backends rely on BashTool's non-overridable command gate. */
  protectProjectMetadata?: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; may be a signal-derived value (e.g. 143) when killed. Use timedOut/cancelled to detect kills. */
  exitCode: number | null;
  timedOut: boolean;
  /** True when the caller aborted. Supersedes timedOut (the two are never both true). */
  cancelled: boolean;
  /** PIDs still alive after teardown verification. Absent/empty means a clean reap;
   *  non-empty means a straggler survived and is surfaced to the user as a warning. */
  survivors?: number[];
}

export interface Sandbox {
  /**
   * Run a shell command. Returns the raw result for any command that actually ran
   * (including a non-zero exit). Throws SandboxUnavailableError only when the sandbox
   * infrastructure itself cannot run the command (e.g. the container failed to start).
   */
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
  dispose(): Promise<void>;
  /** The directory writes are confined to, or null when the sandbox does not confine writes
   *  (backend: none, host→none degrade, or ACP terminal mode where the editor is the boundary). */
  writeRoot(): string | null;
}

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(`sandbox unavailable: ${reason}`);
    this.name = "SandboxUnavailableError";
  }
}
