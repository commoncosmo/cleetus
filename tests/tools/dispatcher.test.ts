import { beforeEach, describe, expect, it } from "bun:test";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolContext } from "../../src/tools/types";

class FakeTool implements Tool {
  name = "echo";
  description = "echo input";
  parameters = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
  serialize(args: unknown) {
    return (args as { text: string }).text;
  }
  async run(args: unknown, _ctx: ToolContext) {
    return { ok: true, output: `said: ${(args as { text: string }).text}` };
  }
}

class ThrowingTool implements Tool {
  name = "boom";
  description = "always throws";
  parameters = { type: "object", properties: {} };
  serialize() {
    return "boom";
  }
  async run(): Promise<never> {
    throw new Error("kaboom");
  }
}

const baseCtx: ToolContext = { projectDir: "/tmp", abortSignal: new AbortController().signal };

describe("ToolDispatcher", () => {
  let reg: ToolRegistry;
  let disp: ToolDispatcher;
  beforeEach(() => {
    reg = new ToolRegistry();
    reg.register(new FakeTool());
    disp = new ToolDispatcher(reg);
  });

  it("dispatches to the registered tool when permission allows", async () => {
    const result = await disp.dispatch({
      tool: "echo",
      args: { text: "hi" },
      context: baseCtx,
      permission: { decision: "allow" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("said: hi");
  });

  it("returns PERMISSION_DENIED result without invoking tool when denied", async () => {
    const result = await disp.dispatch({
      tool: "echo",
      args: { text: "hi" },
      context: baseCtx,
      permission: { decision: "deny" },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PERMISSION_DENIED");
  });

  it("deny returns PERMISSION_DENIED with actionable guidance", async () => {
    const result = await disp.dispatch({
      tool: "bash",
      args: {},
      context: baseCtx,
      permission: { decision: "deny" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("PERMISSION_DENIED");
      expect(result.errorMessage).toBe(
        "The user denied this bash call. Do not retry it. Accomplish the goal a different way, or explain what you wanted to do and ask the user how to proceed.",
      );
    }
  });

  it("returns TOOL_NOT_FOUND when tool missing", async () => {
    const result = await disp.dispatch({
      tool: "missing",
      args: {},
      context: baseCtx,
      permission: { decision: "allow" },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TOOL_NOT_FOUND");
  });

  it("returns TOOL_FAILED when the tool throws", async () => {
    reg.register(new ThrowingTool());
    const result = await disp.dispatch({
      tool: "boom",
      args: {},
      context: baseCtx,
      permission: { decision: "allow" },
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TOOL_FAILED");
    expect(result.errorMessage).toContain("kaboom");
  });
});
