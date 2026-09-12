import { afterEach, describe, expect, it } from "bun:test";
import { connectConfiguredAcpMcp } from "../../src/acp/configured-mcp";
import { EventLog } from "../../src/events/log";
import type { McpConnection } from "../../src/mcp/types";
import { ToolRegistry } from "../../src/tools/registry";

const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
});

function connection(toolName: string, onClose: () => void): McpConnection {
  return {
    connect: async () => {},
    listTools: async () => [{ name: toolName, inputSchema: { type: "object" } }],
    callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    close: async () => onClose(),
  };
}

describe("connectConfiguredAcpMcp", () => {
  it("loads merged Cleetus config servers into the ACP tool registry and shuts them down", async () => {
    const log = new EventLog(":memory:");
    logs.push(log);
    const tools = new ToolRegistry();
    let closes = 0;
    const configured = await connectConfiguredAcpMcp({
      servers: {
        docs: { command: "docs-mcp", args: [], env: {}, enabled: true },
        disabled: { command: "off-mcp", args: [], env: {}, enabled: false },
      },
      tools,
      log,
      factory: (server) => connection(`${server.name}_search`, () => closes++),
    });

    expect(configured.names).toEqual(new Set(["docs", "disabled"]));
    expect(configured.statuses).toEqual([
      {
        name: "disabled",
        state: "disabled",
        toolCount: 0,
        toolNames: [],
      },
      {
        name: "docs",
        state: "connected",
        toolCount: 1,
        toolNames: ["mcp__docs__docs_search"],
      },
    ]);
    expect(tools.get("mcp__docs__docs_search")).toBeDefined();

    await configured.shutdown();
    expect(closes).toBe(1);
  });
});
