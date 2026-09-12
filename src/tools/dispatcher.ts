import type { ToolRegistry } from "./registry";
import type { ToolContext, ToolResult } from "./types";

export interface DispatchRequest {
  tool: string;
  args: unknown;
  context: ToolContext;
  permission: { decision: "allow" | "deny" | "ask" };
}

export class ToolDispatcher {
  constructor(private readonly registry: ToolRegistry) {}

  async dispatch(req: DispatchRequest): Promise<ToolResult> {
    if (req.permission.decision === "deny") {
      return {
        ok: false,
        errorCode: "PERMISSION_DENIED",
        errorMessage: `The user denied this ${req.tool} call. Do not retry it. Accomplish the goal a different way, or explain what you wanted to do and ask the user how to proceed.`,
      };
    }
    if (req.permission.decision === "ask") {
      // The runtime is responsible for upgrading "ask" to allow/deny before dispatch.
      return {
        ok: false,
        errorCode: "PERMISSION_DENIED",
        errorMessage: `unresolved permission for ${req.tool}`,
      };
    }
    const tool = this.registry.get(req.tool);
    if (!tool) {
      return { ok: false, errorCode: "TOOL_NOT_FOUND", errorMessage: `no tool '${req.tool}'` };
    }
    try {
      return await tool.run(req.args, req.context);
    } catch (e) {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
