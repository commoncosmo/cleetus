import { spawnCollect } from "../../sandbox/spawn";
import { hasFile, localBin, onPath } from "../detect";
import { toRelative } from "../relpath";
import type {
  Diagnostic,
  DiagnosticExec,
  DiagnosticsProvider,
  ResolvedCmd,
  RunOutcome,
} from "../types";

const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/** Parse `tsc --noEmit --pretty false` output. */
export function parseTsc(output: string, projectDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const m = TSC_RE.exec(raw.trim());
    if (!m) continue;
    diags.push({
      file: toRelative(projectDir, m[1]!),
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4] as "error" | "warning",
      code: m[5],
      message: m[6]!,
    });
  }
  return diags;
}

export class TypeScriptProvider implements DiagnosticsProvider {
  id = "tsc";
  language = "typescript" as const;

  matches(file: string): boolean {
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file);
  }

  async hasProjectMarker(projectDir: string): Promise<boolean> {
    return await hasFile(projectDir, "tsconfig.json");
  }

  async detect(projectDir: string): Promise<ResolvedCmd | null> {
    const local = await localBin(projectDir, "tsc");
    if (local) return local;
    const bunx = onPath("bunx");
    if (bunx) return { command: bunx, baseArgs: ["tsc"] };
    const global = onPath("tsc");
    if (global) return { command: global, baseArgs: [] };
    return null;
  }

  async run(
    cmd: ResolvedCmd,
    projectDir: string,
    signal: AbortSignal,
    timeoutMs: number,
    exec: DiagnosticExec = spawnCollect,
  ): Promise<RunOutcome> {
    try {
      const res = await exec([cmd.command, ...cmd.baseArgs, "--noEmit", "--pretty", "false"], {
        cwd: projectDir,
        timeoutMs,
        signal,
      });
      if (res.cancelled) return { diagnostics: [], timedOut: false, available: true };
      if (res.timedOut) return { diagnostics: [], timedOut: true, available: true };
      // tsc prints diagnostics to stdout; exit code is non-zero when errors exist (normal).
      return {
        diagnostics: parseTsc(res.stdout + res.stderr, projectDir),
        timedOut: false,
        available: true,
      };
    } catch {
      return { diagnostics: [], timedOut: false, available: false };
    }
  }
}
