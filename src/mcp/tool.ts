import type { Tool, ToolContext, ToolResult } from "../tools/types";
import type { McpConnection, McpContent, McpToolDef } from "./types";

function renderContent(content: McpContent[]): string {
  return content
    .map((c) =>
      c.type === "text" ? (c as { type: "text"; text: string }).text : "[non-text content omitted]",
    )
    .join("\n");
}

export class McpTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;

  constructor(
    private readonly server: string,
    private readonly def: McpToolDef,
    private readonly conn: McpConnection,
  ) {
    this.name = `mcp__${server}__${def.name}`;
    this.description = `[${server}] ${def.description ?? ""}`.trim();
    this.parameters = def.inputSchema ?? { type: "object", properties: {} };
  }

  serialize(args: unknown): string {
    let argText = "";
    try {
      argText = JSON.stringify(args ?? {});
    } catch {
      argText = "?";
    }
    return `${this.name}(${argText})`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    try {
      const res = await this.conn.callTool(this.def.name, args, ctx.abortSignal);
      const text = renderContent(res.content);
      if (res.isError) {
        return { ok: false, errorCode: "TOOL_FAILED", errorMessage: text };
      }
      return { ok: true, output: text };
    } catch {
      return {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: `mcp server '${this.server}' unavailable`,
      };
    }
  }
}
