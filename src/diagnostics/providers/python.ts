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

interface PyrightDiag {
  file: string;
  severity?: string;
  rule?: string;
  message: string;
  range?: { start?: { line?: number; character?: number } };
}

/** Parse `pyright --outputjson`. pyright lines/chars are 0-based. */
export function parsePyright(output: string, projectDir: string): Diagnostic[] {
  let parsed: { generalDiagnostics?: PyrightDiag[] };
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const items = parsed.generalDiagnostics ?? [];
  return items
    .filter((it) => typeof it.file === "string" && it.file.length > 0)
    .map((it) => ({
      file: toRelative(projectDir, it.file),
      line: (it.range?.start?.line ?? 0) + 1,
      col: (it.range?.start?.character ?? 0) + 1,
      severity: it.severity === "error" ? "error" : "warning",
      code: it.rule,
      message: it.message,
    }));
}

interface RuffDiag {
  filename: string;
  code?: string;
  message: string;
  location?: { row?: number; column?: number };
}

/** Parse `ruff check --output-format json`. ruff rows/columns are 1-based. */
export function parseRuff(output: string, projectDir: string): Diagnostic[] {
  let parsed: RuffDiag[];
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((it) => ({
    file: toRelative(projectDir, it.filename),
    line: it.location?.row ?? 1,
    col: it.location?.column ?? 1,
    severity: "warning" as const,
    code: it.code,
    message: it.message,
  }));
}

export class PythonProvider implements DiagnosticsProvider {
  id = "python";
  language = "python" as const;

  matches(file: string): boolean {
    return /\.pyi?$/.test(file);
  }

  async hasProjectMarker(projectDir: string): Promise<boolean> {
    return (await hasFile(projectDir, "pyproject.toml")) || (await hasFile(projectDir, "setup.py"));
  }

  async detect(_projectDir: string): Promise<ResolvedCmd | null> {
    const pyright = onPath("pyright");
    if (pyright) {
      return { command: pyright, baseArgs: ["--outputjson"] };
    }
    const ruff = onPath("ruff");
    if (ruff) {
      return { command: ruff, baseArgs: ["check", "--output-format", "json"] };
    }
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
      const res = await exec([cmd.command, ...cmd.baseArgs, "."], {
        cwd: projectDir,
        timeoutMs,
        signal,
      });
      if (res.cancelled) return { diagnostics: [], timedOut: false, available: true };
      if (res.timedOut) return { diagnostics: [], timedOut: true, available: true };
      const mode = cmd.baseArgs.includes("--outputjson") ? "pyright" : "ruff";
      const diagnostics =
        mode === "pyright"
          ? parsePyright(res.stdout, projectDir)
          : parseRuff(res.stdout, projectDir);
      return { diagnostics, timedOut: false, available: true };
    } catch {
      return { diagnostics: [], timedOut: false, available: false };
    }
  }
}
