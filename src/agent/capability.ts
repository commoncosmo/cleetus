import { LOW_CONTEXT_THRESHOLD } from "../providers/native-context";
import type { Tool } from "../tools/types";

/** How much prompt/tool surface the current model gets. Distinct from routing tiers:
 *  `routing.tiers` picks WHICH model to call; capability shapes what that model sees. */
export type Capability = "small" | "standard";

/** The config-level setting: explicit capability or per-model auto-detection. */
export type CapabilityMode = "small" | "standard" | "auto";

/** The exact built-in roster a small-capability model receives. Everything else that is
 *  registered — except user-configured MCP tools — is dropped from the schema block and
 *  redirected on call (see hiddenToolRedirect). */
export const SMALL_TOOL_ROSTER: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "bash",
  "grep",
  "glob",
  "todo_write",
  "record_findings",
  "run_tests",
  "render_check",
  "smoke_run",
  "scaffold",
]);

/** Task-scoped additions to the small surface. Retrieval models need a direct evidence path;
 * hiding these tools forces them into shell/curl workarounds that cost more context and are less
 * reliable than the purpose-built tools. */
export const SMALL_RETRIEVAL_TOOL_ROSTER: ReadonlySet<string> = new Set([
  "web_search",
  "web_fetch",
  "save_fetched_json",
]);

/** Client-job tools exist only after an ACP client explicitly advertises the extension. Like MCP
 *  tools, that negotiated external surface remains visible regardless of model capability. */
export const CLIENT_JOB_TOOL_ROSTER: ReadonlySet<string> = new Set([
  "job_start",
  "job_status",
  "job_cancel",
  "job_artifact_read",
  "job_artifact_normalize",
]);

/** Exact retrieved artifacts have a purpose-built path. Keeping generic shell and file writers
 * out of this task surface prevents models from bypassing the fetch cache with ad hoc network
 * requests or manually reconstructed payloads. Safe reads remain available for overwrite checks. */
export const EXACT_ARTIFACT_TOOL_ROSTER: ReadonlySet<string> = new Set([
  "web_search",
  "web_fetch",
  "save_fetched_json",
  "read_file",
  "grep",
]);

/** Auto-mode decision for one model: a window below the low-context threshold — or no
 *  window evidence at all — gets the small surface. Unknown→small mirrors WS1.3's
 *  conservative unknown-window clamp: same evidence gap, same conservative answer. */
export function decideCapability(contextLength: number | undefined): Capability {
  return contextLength === undefined || contextLength < LOW_CONTEXT_THRESHOLD
    ? "small"
    : "standard";
}

/** User-configured MCP tools are never filtered (names are `mcp__<server>__<tool>`). */
function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

function isNegotiatedExternalTool(name: string): boolean {
  return isMcpTool(name) || CLIENT_JOB_TOOL_ROSTER.has(name);
}

/** The tools a model of `capability` may see. `standard` passes everything through. */
export function filterToolsForCapability(
  tools: Tool[],
  capability: Capability,
  taskTools: ReadonlySet<string> = new Set(),
): Tool[] {
  if (capability === "standard") return tools;
  return tools.filter(
    (t) =>
      SMALL_TOOL_ROSTER.has(t.name) || taskTools.has(t.name) || isNegotiatedExternalTool(t.name),
  );
}

/** Redirect message for a REGISTERED-but-hidden tool call at small capability, or null when
 *  the call should proceed. Callers must check registration first (`tools.get(name)`), so an
 *  unregistered name keeps the existing unknown-tool error. The map is static and closed:
 *  one deterministic substitute per dropped tool family. */
export function hiddenToolRedirect(
  name: string,
  capability: Capability,
  taskTools: ReadonlySet<string> = new Set(),
): string | null {
  if (capability === "standard") return null;
  if (SMALL_TOOL_ROSTER.has(name) || taskTools.has(name) || isNegotiatedExternalTool(name)) {
    return null;
  }
  const base = `${name} is not available in this session`;
  if (name === "multi_edit" || name === "apply_patch") return `${base}; use edit_file.`;
  if (name === "smoke_run") return `${base}; use bash.`;
  if (name.startsWith("git_") || name === "create_pr") {
    return `${base}; run the git/gh command with bash.`;
  }
  if (name.startsWith("todo_list_")) {
    return `${base}; use todo_write for the working todo list.`;
  }
  return `${base}.`;
}
