export type DiagnosticLanguage = "typescript" | "python" | "go" | "rust";

export interface Diagnostic {
  /** Path relative to projectDir when resolvable, else the checker's raw path. */
  file: string;
  line: number;
  col?: number;
  severity: "error" | "warning";
  /** Rule/error code when the checker provides one (e.g. "TS2304", "F821", "E0425"). */
  code?: string;
  message: string;
}

export interface ResolvedCmd {
  command: string;
  baseArgs: string[];
}

/** Result of one checker run. `available: false` means the binary failed to spawn. */
export interface RunOutcome {
  diagnostics: Diagnostic[];
  timedOut: boolean;
  available: boolean;
}

/** Injectable process runner. ACP supplies one backed by its active sandbox/client terminal;
 * terminal construction omits it and providers retain their direct spawn behavior. */
export type DiagnosticExec = (
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal },
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}>;

export type CheckStatus = "ok" | "no_baseline" | "timeout" | "unavailable";

export interface CheckReport {
  providerId: string;
  language: DiagnosticLanguage;
  newDiagnostics: Diagnostic[];
  fixedCount: number;
  status: CheckStatus;
  /** Model-facing text to append to the turn. */
  text: string;
}

export interface DiagnosticsProvider {
  id: string;
  language: DiagnosticLanguage;
  /** True if this provider handles the given file (by extension). */
  matches(file: string): boolean;
  /** True if the project has this language's marker file (tsconfig.json, go.mod, …). */
  hasProjectMarker(projectDir: string): Promise<boolean>;
  /** Resolve the runnable command, or null if the checker is not installed. */
  detect(projectDir: string): Promise<ResolvedCmd | null>;
  /** Run the checker and parse its output. Must never throw — maps failures to RunOutcome. */
  run(
    cmd: ResolvedCmd,
    projectDir: string,
    signal: AbortSignal,
    timeoutMs: number,
    exec?: DiagnosticExec,
  ): Promise<RunOutcome>;
}
