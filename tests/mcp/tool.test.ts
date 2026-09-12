import { describe, expect, it } from "bun:test";
import { McpTool } from "../../src/mcp/tool";
import type { McpCallResult, McpConnection, McpToolDef } from "../../src/mcp/types";

function fakeConn(over: Partial<McpConnection> = {}): McpConnection {
  return {
    connect: async () => {},
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
    close: async () => {},
    ...over,
  };
}

const def: McpToolDef = {
  name: "search",
  description: "Search repos",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

describe("McpTool", () => {
  it("namespaces the tool name and maps schema/description", () => {
    const t = new McpTool("github", def, fakeConn());
    expect(t.name).toBe("mcp__github__search");
    expect(t.description).toBe("[github] Search repos");
    expect(t.parameters).toEqual(def.inputSchema!);
  });

  it("serializes a one-line summary with compact args", () => {
    const t = new McpTool("github", def, fakeConn());
    expect(t.serialize({ q: "ink" })).toBe('mcp__github__search({"q":"ink"})');
  });

  it("returns ok with joined text content on success", async () => {
    const result: McpCallResult = { content: [{ type: "text", text: "hello" }], isError: false };
    let calledWith: unknown;
    const t = new McpTool(
      "github",
      def,
      fakeConn({
        callTool: async (name, args) => {
          calledWith = { name, args };
          return result;
        },
      }),
    );
    const r = await t.run(
      { q: "ink" },
      { projectDir: "/tmp", abortSignal: new AbortController().signal },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toBe("hello");
    expect(calledWith).toEqual({ name: "search", args: { q: "ink" } });
  });

  it("maps isError:true to a failed ToolResult", async () => {
    const t = new McpTool(
      "github",
      def,
      fakeConn({
        callTool: async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
      }),
    );
    const r = await t.run({}, { projectDir: "/tmp", abortSignal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOOL_FAILED");
    expect(r.errorMessage).toBe("boom");
  });

  it("maps a thrown call (dead transport) to an unavailable error", async () => {
    const t = new McpTool(
      "github",
      def,
      fakeConn({
        callTool: async () => {
          throw new Error("EPIPE");
        },
      }),
    );
    const r = await t.run({}, { projectDir: "/tmp", abortSignal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOOL_FAILED");
    expect(r.errorMessage).toBe("mcp server 'github' unavailable");
  });

  it("replaces non-text content with a placeholder", async () => {
    const t = new McpTool(
      "github",
      def,
      fakeConn({
        callTool: async () => ({
          content: [
            { type: "text", text: "a" },
            { type: "image", data: "..." },
          ],
          isError: false,
        }),
      }),
    );
    const r = await t.run({}, { projectDir: "/tmp", abortSignal: new AbortController().signal });
    expect(r.output).toBe("a\n[non-text content omitted]");
  });

  it("applies fallbacks when description and inputSchema are absent", () => {
    const minimal = { name: "bare" } as McpToolDef;
    const t = new McpTool("github", minimal, fakeConn());
    expect(t.name).toBe("mcp__github__bare");
    expect(t.description).toBe("[github]");
    expect(t.parameters).toEqual({ type: "object", properties: {} });
  });
});
