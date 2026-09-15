import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendRegion } from "./changed-region";
import { guardedWrite } from "./guarded-write";
import { nearMissHint } from "./near-miss";
import { refuseIfSecretPath } from "./read-guard";
import { applyReplacement } from "./replace";
import type { Tool, ToolContext, ToolResult } from "./types";
import { refuseIfOutsideProject } from "./within-project";

interface Args {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export class EditFileTool implements Tool {
  name = "edit_file";
  mutates = true;
  description =
    "Replace `old_text` with `new_text` in a file. Default expects exactly one occurrence; pass `replace_all` to replace every occurrence.";
  parameters = {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
      replace_all: { type: "boolean", default: false },
    },
    required: ["path", "old_text", "new_text"],
  };
  serialize(args: unknown): string {
    const a = args as Args;
    return `edit_file ${a.path}${a.replaceAll ? " (all)" : ""}`;
  }
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const raw = args as Record<string, unknown>;
    const a: Args = {
      path: raw.path as string,
      oldText: (raw.oldText ?? raw.old_text) as string,
      newText: (raw.newText ?? raw.new_text) as string,
      replaceAll: Boolean(raw.replaceAll ?? raw.replace_all),
    };
    const refusal = await refuseIfOutsideProject(a.path, ctx);
    if (refusal) return refusal;
    const secretRefusal = await refuseIfSecretPath(a.path, ctx);
    if (secretRefusal) return secretRefusal;
    const path = resolve(ctx.projectDir, a.path);
    try {
      const text = await readFile(path, "utf8");
      const result = applyReplacement(text, {
        oldText: a.oldText,
        newText: a.newText,
        replaceAll: a.replaceAll,
      });
      if (!result.ok) {
        let msg = result.reason;
        if (result.code === "not_found") {
          const hint = nearMissHint(text, a.oldText);
          if (hint) msg = `${msg}\n\n${hint}`;
        }
        return { ok: false, errorCode: "TOOL_FAILED", errorMessage: msg };
      }
      await guardedWrite(path, result.text, ctx);
      const note = result.whitespaceTolerant ? ", matched ignoring indentation" : "";
      const base = `edited ${path} (${result.count} replacement${result.count === 1 ? "" : "s"}${note})`;
      return {
        ok: true,
        output: appendRegion(base, text, result.text),
        diff: { path, before: text, after: result.text },
      };
    } catch (e) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: (e as Error).message };
    }
  }
}
