/** One file's format outcome. `changed` drives whether a notice is emitted. */
export interface FormatResult {
  /** The path as passed to formatFiles (the edited-path entry). */
  path: string;
  changed: boolean;
  /** Formatter that ran, e.g. "ruff" | "black". */
  tool: string;
}

/** Post-write formatter seam. `formatFiles` returns ONLY the files it changed. */
export interface Formatter {
  formatFiles(files: string[], signal: AbortSignal): Promise<FormatResult[]>;
}

/** Injected side-effects, so the formatter unit-tests without real tools or disk. */
export interface FormatDeps {
  /** Resolve a binary on PATH, or null (Bun.which). */
  which: (bin: string) => string | null;
  /** True if an absolute path exists (for .venv/bin detection). */
  fileExists: (absPath: string) => Promise<boolean>;
  /** Read a file's text (before/after change detection). */
  readFile: (absPath: string) => Promise<string>;
  /** Run a command; only the exit code is needed. Never rejects on non-zero exit. */
  spawn: (
    argv: string[],
    opts: { cwd: string; signal: AbortSignal },
  ) => Promise<{ exitCode: number | null }>;
}
