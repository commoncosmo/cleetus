import { resolve } from "node:path";
import type { FormatConfig } from "../config/types";
import { toRelative } from "../diagnostics/relpath";
import { detectPythonFormatter, formatPythonFile } from "./python";
import type { FormatDeps, FormatResult, Formatter } from "./types";

const NOOP: Formatter = { formatFiles: async () => [] };

/** Build the post-write formatter. No-op when disabled or when no formatter is detected.
 *  Detection runs once at build time (async). */
export async function buildFormatter(
  config: FormatConfig,
  opts: { projectDir: string; deps: FormatDeps },
): Promise<Formatter> {
  if (!config.enabled) return NOOP;
  const det = await detectPythonFormatter(opts.projectDir, opts.deps);
  if (!det) return NOOP;
  return {
    async formatFiles(files, signal) {
      const results: FormatResult[] = [];
      for (const f of files) {
        if (!f.endsWith(".py")) continue;
        const abs = resolve(opts.projectDir, f);
        const r = await formatPythonFile(abs, det, opts.projectDir, opts.deps, signal);
        // Report a project-relative path for the notice — editedPaths are absolute, and this
        // matches the diagnostics rows (toRelative), so the notice reads `main.py`, not a full path.
        if (r.changed)
          results.push({ path: toRelative(opts.projectDir, abs), changed: true, tool: r.tool });
      }
      return results;
    },
  };
}

/** Terse, model-visible notice: one `↻ formatted <path> (<tool>)` line per changed file. */
export function formatNotice(results: FormatResult[]): string {
  return results.map((r) => `↻ formatted ${r.path} (${r.tool})`).join("\n");
}
