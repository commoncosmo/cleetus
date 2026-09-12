import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../src/tools/registry";
import { SubagentTool, filterToolsForType } from "../../../src/tools/subagent/tool";
import type { Tool, ToolContext, ToolResult } from "../../../src/tools/types";

const ctx: ToolContext = { projectDir: "/proj", abortSignal: new AbortController().signal };

/** Minimal tool stub with a controllable name + mutates flag. */
function tool(name: string, mutates?: boolean): Tool {
  return {
    name,
    description: name,
    mutates,
    parameters: { type: "object", properties: {} },
    serialize: () => name,
    run: async (): Promise<ToolResult> => ({ ok: true }),
  };
}

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool("read_file")); // read
  r.register(tool("grep")); // read
  r.register(tool("edit_file", true)); // write
  r.register(tool("bash", true)); // write
  r.register(tool("task", true)); // the subagent tool itself
  return r;
}

describe("filterToolsForType", () => {
  test("general gets everything except task (no recursion)", () => {
    const names = filterToolsForType(registry(), "general")
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["bash", "edit_file", "grep", "read_file"]);
  });

  test("explore gets only non-mutating tools, except task", () => {
    const names = filterToolsForType(registry(), "explore")
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["grep", "read_file"]);
  });
});

describe("SubagentTool", () => {
  test("is mutating and serializes a labelled summary", () => {
    const t = new SubagentTool(async () => ({ assistantText: "" }));
    expect(t.name).toBe("task");
    expect(t.mutates).toBe(true);
    expect(t.serialize({ agent_type: "explore", description: "map the   auth flow" })).toBe(
      "🤖 task(explore): map the auth flow",
    );
  });

  test("forwards {type, prompt, signal} and maps success to output", async () => {
    const seen: { type: string; prompt: string }[] = [];
    const t = new SubagentTool(async ({ type, prompt }) => {
      seen.push({ type, prompt });
      return { assistantText: "the summary" };
    });
    const r = await t.run({ agent_type: "general", description: "do the thing" }, ctx);
    expect(seen[0]).toEqual({ type: "general", prompt: "do the thing" });
    expect(r).toMatchObject({ ok: true, output: "the summary" });
  });

  test("a spawn failure becomes a failed result, not a throw", async () => {
    const t = new SubagentTool(async () => {
      throw new Error("provider exploded");
    });
    const r = await t.run({ agent_type: "general", description: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("provider exploded");
  });

  test("rejects an unknown agent_type without spawning", async () => {
    let spawned = false;
    const t = new SubagentTool(async () => {
      spawned = true;
      return { assistantText: "" };
    });
    const r = await t.run({ agent_type: "wizard", description: "x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("agent_type");
    expect(spawned).toBe(false);
  });

  test("rejects an empty description without spawning", async () => {
    let spawned = false;
    const t = new SubagentTool(async () => {
      spawned = true;
      return { assistantText: "" };
    });
    const r = await t.run({ agent_type: "general", description: "   " }, ctx);
    expect(r.ok).toBe(false);
    expect(spawned).toBe(false);
  });
});
