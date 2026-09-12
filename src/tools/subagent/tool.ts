import type { ToolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

export type SubagentType = "general" | "explore" | "review";

const TYPES: SubagentType[] = ["general", "explore", "review"];

/** Execution tools the adversarial `review` role may use on top of the read-only set, so it can
 *  verify a suspected defect by running it. Kept tiny and explicit: an allow-list on top of the
 *  `!mutates` base is safer than a deny-list, which would have to enumerate every VCS/file-mutating
 *  tool and could silently miss one. */
export const REVIEW_EXEC_ALLOW = new Set(["run_tests", "bash"]);

/** What the tool needs to launch a sub-agent. Returns the sub-agent's final summary.
 *  Kept structural (no agent import) so the tool layer doesn't depend on the runtime. */
export type SpawnSubagent = (req: {
  type: SubagentType;
  prompt: string;
  signal: AbortSignal;
}) => Promise<{ assistantText: string }>;

/**
 * The tools a sub-agent of `type` may use:
 * - `general` — every registered tool EXCEPT `task` (depth-1: no recursion).
 * - `explore` — only non-mutating (read-only) tools, EXCEPT `task`.
 * - `review`  — read-only tools PLUS `REVIEW_EXEC_ALLOW` (run_tests, bash), EXCEPT `task`. The
 *   `!mutates` base auto-excludes all file/VCS-mutating tools, so the reviewer structurally cannot
 *   edit files or change VCS state.
 */
export function filterToolsForType(registry: ToolRegistry, type: SubagentType): Tool[] {
  return registry.all().filter((t) => {
    if (t.name === "task") return false;
    if (type === "explore") return !t.mutates;
    if (type === "review") return !t.mutates || REVIEW_EXEC_ALLOW.has(t.name);
    return true;
  });
}

const MAX_LABEL = 50;

/** Delegate a sub-task to a fresh, context-isolated sub-agent that returns a summary. */
export class SubagentTool implements Tool {
  name = "task";
  description =
    "Delegate a sub-task to a fresh sub-agent that runs in its own isolated context and " +
    "returns a summary. agent_type 'general' has the full toolset; 'explore' is read-only " +
    "(no edits, no commands); 'review' is an adversarial code reviewer that can read and run " +
    "tests/commands but cannot edit — use it to review your own changes before finishing. Use " +
    "task to keep the main context clean and isolate sub-tasks that may need to fail and retry.";
  mutates = true;
  parameters = {
    type: "object",
    properties: {
      agent_type: {
        type: "string",
        enum: ["general", "explore", "review"],
        description:
          "'general' (full tools), 'explore' (read-only), or 'review' (adversarial reviewer).",
      },
      description: {
        type: "string",
        description: "The task for the sub-agent to perform, as a self-contained instruction.",
      },
    },
    required: ["agent_type", "description"],
    additionalProperties: false,
  };

  constructor(private readonly spawn: SpawnSubagent) {}

  serialize(args: unknown): string {
    const a = (args ?? {}) as { agent_type?: string; description?: string };
    const desc = (a.description ?? "").replace(/\s+/g, " ").trim();
    const short = desc.length <= MAX_LABEL ? desc : `${desc.slice(0, MAX_LABEL - 1)}…`;
    return `🤖 task(${a.agent_type ?? "?"}): ${short}`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const a = (args ?? {}) as { agent_type?: unknown; description?: unknown };
    if (a.agent_type !== "general" && a.agent_type !== "explore" && a.agent_type !== "review") {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `agent_type must be one of: ${TYPES.join(", ")}`,
      };
    }
    const prompt = typeof a.description === "string" ? a.description : "";
    if (!prompt.trim()) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "description must be a non-empty string",
      };
    }
    try {
      const result = await this.spawn({ type: a.agent_type, prompt, signal: ctx.abortSignal });
      return { ok: true, output: result.assistantText };
    } catch (e) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `subagent failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
