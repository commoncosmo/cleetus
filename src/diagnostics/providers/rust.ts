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

interface CargoSpan {
  file_name: string;
  line_start: number;
  column_start: number;
  is_primary: boolean;
}
interface CargoMessage {
  reason: string;
  message?: {
    level?: string;
    message?: string;
    code?: { code?: string } | null;
    spans?: CargoSpan[];
  };
}

/** Parse `cargo check --message-format=json` (newline-delimited JSON). */
export function parseCargoCheck(output: string, projectDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  for (const raw of output.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: CargoMessage;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.reason !== "compiler-message" || !obj.message) continue;
    const m = obj.message;
    const spans = m.spans ?? [];
    const span = spans.find((s) => s.is_primary) ?? spans[0];
    if (!span) continue;
    const level = m.level === "error" ? "error" : "warning";
    diags.push({
      file: toRelative(projectDir, span.file_name),
      line: span.line_start,
      col: span.column_start,
      severity: level,
      code: m.code?.code,
      message: m.message ?? "",
    });
  }
  return diags;
}

export class RustProvider implements DiagnosticsProvider {
  id = "cargo-check";
  language = "rust" as const;

  matches(file: string): boolean {
    return file.endsWith(".rs");
  }

  async hasProjectMarker(projectDir: string): Promise<boolean> {
    return await hasFile(projectDir, "Cargo.toml");
  }

  async detect(_projectDir: string): Promise<ResolvedCmd | null> {
    const cargo = onPath("cargo");
    return cargo ? { command: cargo, baseArgs: ["check", "--message-format=json"] } : null;
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
      // cargo writes the JSON message stream to stdout.
      return {
        diagnostics: parseCargoCheck(res.stdout, projectDir),
        timedOut: false,
        available: true,
      };
    } catch {
      return { diagnostics: [], timedOut: false, available: false };
    }
  }
}
