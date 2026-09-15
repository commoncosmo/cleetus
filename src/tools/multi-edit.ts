import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { appendRegion } from "./changed-region";
import { guardedWrite } from "./guarded-write";
import { nearMissHint } from "./near-miss";
import { refuseIfSecretPath } from "./read-guard";
import { applyReplacement } from "./replace";
import type { Tool, ToolContext, ToolResult } from "./types";
import { refuseIfOutsideProject } from "./within-project";

interface EditArg {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

type NormalizeResult = { ok: true; edits: EditArg[] } | { ok: false; error: string };

/**
 * Accept both camelCase and snake_case edit fields (mirrors edit_file's tolerance)
 * and reject malformed entries — a non-string old_text/new_text would otherwise be
 * coerced and could write the literal "undefined" into the file. A non-array (or
 * missing) `edits` yields an empty list, handled by the `no edits provided` guard.
 */
function normalizeEdits(raw: unknown): NormalizeResult {
  if (!Array.isArray(raw)) return { ok: true, edits: [] };
  const n = raw.length;
  const edits: EditArg[] = [];
  for (let i = 0; i < n; i++) {
    const r = (raw[i] ?? {}) as Record<string, unknown>;
    const oldText = r.oldText ?? r.old_text;
    const newText = r.newText ?? r.new_text;
    if (typeof oldText !== "string") {
      return { ok: false, error: `edit ${i + 1} of ${n} failed: old_text must be a string` };
    }
    if (typeof newText !== "string") {
      return { ok: false, error: `edit ${i + 1} of ${n} failed: new_text must be a string` };
    }
    edits.push({ oldText, newText, replaceAll: Boolean(r.replaceAll ?? r.replace_all) });
  }
  return { ok: true, edits };
}

export class MultiEditTool implements Tool {
  name = "multi_edit";
  mutates = true;
  description =
    "Apply an ordered list of search/replace edits to a single file in one call. Each edit " +
    "replaces `old_text` with `new_text` (pass `replace_all` to replace every occurrence). " +
    "Edits apply in sequence, each matching the result of the previous one. Either all edits " +
    "succeed or none are written. Prefer this over multiple edit_file calls when changing the " +
    "same file in several places.";
  parameters = {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old_text: { type: "string" },
            new_text: { type: "string" },
            replace_all: { type: "boolean", default: false },
          },
          required: ["old_text", "new_text"],
        },
      },
    },
    required: ["path", "edits"],
  };

  serialize(args: unknown): string {
    const a = args as { path: string; edits?: unknown[] };
    const n = Array.isArray(a.edits) ? a.edits.length : 0;
    return `multi_edit ${a.path} (${n} edit${n === 1 ? "" : "s"})`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const raw = args as Record<string, unknown>;
    const refusal = await refuseIfOutsideProject(raw.path as string, ctx);
    if (refusal) return refusal;
    const secretRefusal = await refuseIfSecretPath(raw.path as string, ctx);
    if (secretRefusal) return secretRefusal;
    const path = resolve(ctx.projectDir, raw.path as string);
    const norm = normalizeEdits(raw.edits);
    if (!norm.ok) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: norm.error };
    }
    const edits = norm.edits;
    if (edits.length === 0) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "no edits provided" };
    }
    try {
      const before = await readFile(path, "utf8");
      let text = before;
      let total = 0;
      let wsTolerant = false;
      for (let i = 0; i < edits.length; i++) {
        const res = applyReplacement(text, edits[i]!);
        if (!res.ok) {
          // Atomic: nothing has been written, so the on-disk file is untouched.
          let msg = `edit ${i + 1} of ${edits.length} failed: ${res.reason}`;
          if (res.code === "not_found") {
            const hint = nearMissHint(text, edits[i]!.oldText);
            if (hint) msg = `${msg}\n\n${hint}`;
          }
          return { ok: false, errorCode: "TOOL_FAILED", errorMessage: msg };
        }
        text = res.text;
        total += res.count;
        if (res.whitespaceTolerant) wsTolerant = true;
      }
      await guardedWrite(path, text, ctx);
      const note = wsTolerant ? ", some matched ignoring indentation" : "";
      const base = `applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${path} (${total} replacement${total === 1 ? "" : "s"}${note})`;
      return {
        ok: true,
        output: appendRegion(base, before, text),
        diff: { path, before, after: text },
      };
    } catch (e) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: (e as Error).message };
    }
  }
}
