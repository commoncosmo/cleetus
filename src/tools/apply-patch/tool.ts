import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { appendRegion } from "../changed-region";
import { refuseIfSecretPath } from "../read-guard";
import type { Tool, ToolContext, ToolResult } from "../types";
import { refuseIfOutsideProject } from "../within-project";
import { applyUpdate } from "./apply";
import { parsePatch, patchTargetPath } from "./parse";

interface Args {
  patch: string;
}

export class ApplyPatchTool implements Tool {
  name = "apply_patch";
  mutates = true;
  description =
    "Apply a patch to ONE file using the `*** Begin Patch` format — either `*** Update File: <path>` " +
    "with `@@` context hunks (lines prefixed ` ` for context, `-` to remove, `+` to add), or " +
    "`*** Add File: <path>` followed by `+` lines for a new file. Prefer this for multi-hunk edits " +
    "to a single file, or when edit_file/multi_edit keep failing because the exact text is hard to " +
    "reproduce — apply_patch matches by surrounding context and tolerates minor whitespace " +
    "differences. One file per patch.";
  parameters = {
    type: "object",
    properties: {
      patch: {
        type: "string",
        description: "The full `*** Begin Patch` ... `*** End Patch` text.",
      },
    },
    required: ["patch"],
  };

  serialize(args: unknown): string {
    const p = (args as Args).patch ?? "";
    return `apply_patch ${patchTargetPath(p) ?? "(?)"}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const patch = (args as Args).patch;
    const parsed = parsePatch(typeof patch === "string" ? patch : "");
    if ("error" in parsed) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: parsed.error };
    }
    // Check project containment BEFORE resolving, so raw `..` paths are caught.
    const refusal = await refuseIfOutsideProject(parsed.path, ctx);
    if (refusal) return refusal;
    const secretRefusal = await refuseIfSecretPath(parsed.path, ctx);
    if (secretRefusal) return secretRefusal;
    const path = resolve(ctx.projectDir, parsed.path);

    try {
      if (parsed.op === "add") {
        const after = `${parsed.lines.join("\n")}\n`;
        await mkdir(dirname(path), { recursive: true });
        try {
          // `wx` = create-exclusive: fails atomically if the file exists (no TOCTOU window).
          await writeFile(path, after, { flag: "wx" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") {
            return {
              ok: false,
              errorCode: "TOOL_FAILED",
              errorMessage: `file already exists: ${path}. Use '*** Update File:' to modify it.`,
            };
          }
          throw e; // surfaced by the outer catch
        }
        return {
          ok: true,
          output: `created ${path} (${parsed.lines.length} lines)`,
          diff: { path, before: "", after, created: true },
        };
      }

      // op === "update"
      let before: string;
      try {
        before = await readFile(path, "utf8");
      } catch {
        return {
          ok: false,
          errorCode: "TOOL_FAILED",
          errorMessage: `file not found: ${path}. Use '*** Add File:' to create it.`,
        };
      }
      const res = applyUpdate(before, parsed.hunks);
      if (!res.ok) {
        return { ok: false, errorCode: "TOOL_FAILED", errorMessage: res.reason };
      }
      await writeFile(path, res.after);
      const base = `patched ${path} (${parsed.hunks.length} hunk${parsed.hunks.length === 1 ? "" : "s"})`;
      return {
        ok: true,
        output: appendRegion(base, before, res.after),
        diff: { path, before, after: res.after, created: false },
      };
    } catch (e) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: (e as Error).message };
    }
  }
}
