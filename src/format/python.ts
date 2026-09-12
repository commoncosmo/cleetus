import { join } from "node:path";
import type { FormatDeps } from "./types";

export interface DetectedFormatter {
  tool: "ruff" | "black";
  command: string;
  args: string[];
}

/** Prefer ruff over black; for each, prefer the project `.venv/bin` over PATH. null if neither. */
export async function detectPythonFormatter(
  projectDir: string,
  deps: FormatDeps,
): Promise<DetectedFormatter | null> {
  for (const tool of ["ruff", "black"] as const) {
    const args = tool === "ruff" ? ["format"] : [];
    const venvBin = join(projectDir, ".venv", "bin", tool);
    if (await deps.fileExists(venvBin)) return { tool, command: venvBin, args };
    const onPath = deps.which(tool);
    if (onPath) return { tool, command: onPath, args };
  }
  return null;
}

/** Format one file in place; `changed` = the bytes differ. Never throws: a non-zero exit
 *  (unparseable input → the formatter leaves the file untouched) or any error → changed:false. */
export async function formatPythonFile(
  absPath: string,
  det: DetectedFormatter,
  projectDir: string,
  deps: FormatDeps,
  signal: AbortSignal,
): Promise<{ changed: boolean; tool: "ruff" | "black" }> {
  try {
    const before = await deps.readFile(absPath);
    const res = await deps.spawn([det.command, ...det.args, absPath], { cwd: projectDir, signal });
    if (res.exitCode !== 0) return { changed: false, tool: det.tool };
    const after = await deps.readFile(absPath);
    return { changed: before !== after, tool: det.tool };
  } catch {
    return { changed: false, tool: det.tool };
  }
}
