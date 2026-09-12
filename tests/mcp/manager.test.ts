import { describe, expect, it } from "bun:test";
import { EventLog } from "../../src/events/log";
import { McpManager } from "../../src/mcp/manager";
import type { ClientFactory, McpConnection, NamedServerConfig } from "../../src/mcp/types";
import { ToolRegistry } from "../../src/tools/registry";

function memLog(): EventLog {
  return new EventLog(":memory:");
}

function server(name: string, enabled = true): NamedServerConfig {
  return { name, command: "x", args: [], env: {}, enabled };
}

function okConn(toolNames: string[]): McpConnection {
  return {
    connect: async () => {},
    listTools: async () => toolNames.map((n) => ({ name: n, inputSchema: { type: "object" } })),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    close: async () => {},
  };
}

describe("McpManager", () => {
  it("connects healthy servers and registers their tools (prefixed)", async () => {
    const factory: ClientFactory = (s) => okConn(s.name === "a" ? ["one", "two"] : ["solo"]);
    const mgr = new McpManager({
      servers: [server("a"), server("b")],
      factory,
      log: memLog(),
      timeoutMs: 1000,
    });
    await mgr.connectAll();
    const reg = new ToolRegistry();
    mgr.registerInto(reg);
    const names = reg
      .all()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["mcp__a__one", "mcp__a__two", "mcp__b__solo"]);
  });

  it("marks a failing server as failed without affecting others", async () => {
    const factory: ClientFactory = (s) =>
      s.name === "bad"
        ? {
            connect: async () => {
              throw new Error("spawn failed");
            },
            listTools: async () => [],
            callTool: async () => ({ content: [], isError: false }),
            close: async () => {},
          }
        : okConn(["good"]);
    const mgr = new McpManager({
      servers: [server("bad"), server("ok")],
      factory,
      log: memLog(),
      timeoutMs: 1000,
    });
    await mgr.connectAll();
    const status = mgr.status();
    expect(status.find((s) => s.name === "bad")!.state).toBe("failed");
    expect(status.find((s) => s.name === "bad")!.error).toContain("spawn failed");
    expect(status.find((s) => s.name === "ok")!.state).toBe("connected");
    expect(status.find((s) => s.name === "ok")!.toolNames).toEqual(["mcp__ok__good"]);
  });

  it("times out a slow connect and marks it failed", async () => {
    const factory: ClientFactory = () => ({
      connect: () => new Promise(() => {}),
      listTools: async () => [],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
    });
    const mgr = new McpManager({
      servers: [server("slow")],
      factory,
      log: memLog(),
      timeoutMs: 30,
    });
    await mgr.connectAll();
    expect(mgr.status()[0]!.state).toBe("failed");
    expect(mgr.status()[0]!.error).toContain("timed out");
  });

  it("skips disabled servers", async () => {
    const factory: ClientFactory = () => okConn(["x"]);
    const mgr = new McpManager({
      servers: [server("off", false)],
      factory,
      log: memLog(),
      timeoutMs: 1000,
    });
    await mgr.connectAll();
    expect(mgr.status()[0]!.state).toBe("disabled");
    const reg = new ToolRegistry();
    mgr.registerInto(reg);
    expect(reg.all()).toHaveLength(0);
  });

  it("closes every open connection on shutdown", async () => {
    let closes = 0;
    const factory: ClientFactory = () => ({
      connect: async () => {},
      listTools: async () => [{ name: "t", inputSchema: { type: "object" } }],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {
        closes++;
      },
    });
    const mgr = new McpManager({
      servers: [server("a"), server("b")],
      factory,
      log: memLog(),
      timeoutMs: 1000,
    });
    await mgr.connectAll();
    await mgr.shutdown();
    expect(closes).toBe(2);
  });

  it("marks a server failed if listTools throws after a successful connect", async () => {
    let closed = false;
    const factory: ClientFactory = () => ({
      connect: async () => {},
      listTools: async () => {
        throw new Error("list boom");
      },
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {
        closed = true;
      },
    });
    const mgr = new McpManager({ servers: [server("x")], factory, log: memLog(), timeoutMs: 1000 });
    await mgr.connectAll();
    const st = mgr.status()[0]!;
    expect(st.state).toBe("failed");
    expect(st.error).toContain("list boom");
    expect(closed).toBe(true);
  });
});
