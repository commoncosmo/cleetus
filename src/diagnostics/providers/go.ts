import { spawnCollect } from "../../sandbox/spawn";
import { hasFile, onPath } from "../detect";
import { toRelative } from "../relpath";
import type {
  Diagnostic,
  DiagnosticExec,
  DiagnosticsProvider,
  ResolvedCmd,
  RunOutcome,
} from "../types";

const GOVET_RE = /^(.+?\.go):(\d+):(\d+):\s+(.*)$/;

/** Parse `go vet ./...` stderr. Package header lines ("# pkg") are skipped by the regex. */
export function parseGoVet(output: string, projectDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const m = GOVET_RE.exec(raw.trim());
    if (!m) continue;
    diags.push({
      file: toRelative(projectDir, m[1]!),
      line: Number(m[2]),
      col: Number(m[3]),
      severity: "error",
      message: m[4]!,
    });
  }
  return diags;
}

export class GoProvider implements DiagnosticsProvider {
  id = "go-vet";
  language = "go" as const;

  matches(file: string): boolean {
    return file.endsWith(".go");
  }

  async hasProjectMarker(projectDir: string): Promise<boolean> {
    return await hasFile(projectDir, "go.mod");
  }

  async detect(_projectDir: string): Promise<ResolvedCmd | null> {
    const go = onPath("go");
    return go ? { command: go, baseArgs: ["vet", "./..."] } : null;
  }

  async run(
    cmd: ResolvedCmd,
    projectDir: string,
    signal: AbortSignal,
    timeoutMs: number,
    exec: DiagnosticExec = spawnCollect,
  ): Promise<RunOutcome> {
    try {
      const res = await exec([cmd.command, ...cmd.baseArgs], {
        cwd: projectDir,
        timeoutMs,
        signal,
      });
      if (res.cancelled) return { diagnostics: [], timedOut: false, available: true };
      if (res.timedOut) return { diagnostics: [], timedOut: true, available: true };
      // go vet writes diagnostics to stderr.
      return { diagnostics: parseGoVet(res.stderr, projectDir), timedOut: false, available: true };
    } catch {
      return { diagnostics: [], timedOut: false, available: false };
    }
  }
}
