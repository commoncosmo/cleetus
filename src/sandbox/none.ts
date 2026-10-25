import { normalizeWindowsResult } from "./powershell-output";
import { powershellArgs } from "./shell";
import { spawnCollect } from "./spawn";
import type { ExecOptions, ExecResult, Sandbox } from "./types";

/** Runs commands directly on the host via `bash -c`. The backward-compatible default. */
export class NoneSandbox implements Sandbox {
  readonly shell = process.platform === "win32" ? ("powershell" as const) : ("bash" as const);
  constructor(
    private readonly projectDir: string,
    private readonly executable?: string,
  ) {}

  async shellExecutable(): Promise<string> {
    return this.executable ?? (this.shell === "powershell" ? "pwsh.exe" : "bash");
  }

  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const argv =
      this.shell === "powershell"
        ? [this.executable ?? "pwsh.exe", ...powershellArgs(command)]
        : [this.executable ?? "bash", "-c", command];
    return spawnCollect(argv, { ...opts, cwd: opts.cwd ?? this.projectDir }).then((result) =>
      this.shell === "powershell" ? normalizeWindowsResult(result) : result,
    );
  }

  async dispose(): Promise<void> {}

  writeRoot(): string | null {
    return null;
  }
}
