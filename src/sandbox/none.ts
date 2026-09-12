import { spawnCollect } from "./spawn";
import type { ExecOptions, ExecResult, Sandbox } from "./types";

/** Runs commands directly on the host via `bash -c`. The backward-compatible default. */
export class NoneSandbox implements Sandbox {
  constructor(private readonly projectDir: string) {}

  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    return spawnCollect(["bash", "-c", command], { ...opts, cwd: opts.cwd ?? this.projectDir });
  }

  async dispose(): Promise<void> {}

  writeRoot(): string | null {
    return null;
  }
}
