import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { EventLog } from "../../src/events/log";
import { McpManager, createStdioConnection } from "../../src/mcp";
import type { NamedServerConfig } from "../../src/mcp/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

const FIXTURE = join(import.meta.dir, "fixtures", "echo-server.ts");

describe("MCP integration (real stdio transport)", () => {
  it("spawns a server, registers its tool, and round-trips a call via the dispatcher", async () => {
    const servers: NamedServerConfig[] = [
      { name: "echo", command: "bun", args: [FIXTURE], env: {}, enabled: true },
    ];
    const mgr = new McpManager({
      servers,
      factory: createStdioConnection,
      log: new EventLog(":memory:"),
      timeoutMs: 15_000,
    });
    await mgr.connectAll();
    expect(mgr.status()[0]!.state).toBe("connected");

    const reg = new ToolRegistry();
    mgr.registerInto(reg);
    const tool = reg.get("mcp__echo__echo");
    expect(tool).toBeDefined();

    const dispatcher = new ToolDispatcher(reg);
    const result = await dispatcher.dispatch({
      tool: "mcp__echo__echo",
      args: { text: "hello mcp" },
      context: { projectDir: process.cwd(), abortSignal: new AbortController().signal },
      permission: { decision: "allow" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello mcp");

    await mgr.shutdown();
  }, 20_000);
});
