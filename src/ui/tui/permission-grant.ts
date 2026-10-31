import { dirname } from "node:path";
import {
  type CommandContext,
  buildCommandRule,
  commandPatternMatches,
} from "../../permission/command-pattern";
import {
  PATH_READING_TOOLS,
  PATH_WRITING_TOOLS,
  type PermissionRule,
} from "../../permission/types";

/** Prefill for the broaden field: the command for bash; the target's PARENT dir for write
 *  tools and read_file (their target is a file); the target itself for glob/grep (their
 *  target is already a directory); else null (no broaden offered). */
export function defaultGrantInput(
  tool: string,
  summary: string,
  targetPath?: string,
): string | null {
  if (tool === "bash") return summary;
  if ((PATH_WRITING_TOOLS.has(tool) || tool === "read_file") && targetPath) {
    return dirname(targetPath);
  }
  if ((tool === "glob" || tool === "grep") && targetPath) return targetPath;
  return null;
}

/** Shell edits with execution context produce scoped argument patterns. Legacy callers without
 * context retain their raw prefix rule; read/write tools produce directory rules. */
export function buildGrantRule(
  tool: string,
  edited: string,
  commandContext?: CommandContext,
): Omit<PermissionRule, "decision"> | null {
  const text = edited.trim();
  if (!text) return null;
  if (tool === "bash") {
    if (commandContext)
      return commandPatternMatches(text, commandContext.command)
        ? buildCommandRule(text, commandContext)
        : null;
    return { tool: "bash", argsPattern: text.endsWith("*") ? text : `${text}*` };
  }
  if (PATH_WRITING_TOOLS.has(tool) || PATH_READING_TOOLS.has(tool)) return { pathPrefix: text };
  return null;
}

/** Quick-grant rule for an out-of-project READ prompt's [a]/[g] keys: the directory-scoped
 *  pathPrefix rule built from the default broaden prefill, so a one-keystroke allow is never
 *  broader than "reads under this directory". Null when no prefill is derivable. */
export function readEscapeQuickGrant(
  tool: string,
  summary: string,
  targetPath?: string,
): Omit<PermissionRule, "decision"> | null {
  const prefill = defaultGrantInput(tool, summary, targetPath);
  return prefill ? buildGrantRule(tool, prefill) : null;
}
