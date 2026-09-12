import { expect, test } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry";
import { filterToolsForType } from "../../src/tools/subagent/tool";
import type { Tool } from "../../src/tools/types";

function stub(name: string, mutates: boolean): Tool {
  return {
    name,
    description: name,
    mutates,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async run() {
      return { ok: true, output: "" };
    },
  } as unknown as Tool;
}

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const [n, m] of [
    ["read_file", false],
    ["grep", false],
    ["git_diff", false],
    ["run_tests", true],
    ["bash", true],
    ["write_file", true],
    ["edit_file", true],
    ["multi_edit", true],
    ["apply_patch", true],
    ["scaffold", true],
    ["smoke_run", true],
    ["git_commit", true],
    ["git_push", true],
    ["git_add", true],
    ["create_pr", true],
    ["task", true],
  ] as const) {
    r.register(stub(n, m));
  }
  return r;
}

test("review envelope = read-only + run_tests + bash, and nothing else mutating", () => {
  const names = new Set(filterToolsForType(reg(), "review").map((t) => t.name));
  // read-only present
  expect(names.has("read_file")).toBe(true);
  expect(names.has("grep")).toBe(true);
  expect(names.has("git_diff")).toBe(true);
  // the two execution tools re-admitted
  expect(names.has("run_tests")).toBe(true);
  expect(names.has("bash")).toBe(true);
  // every other mutating tool excluded (structural "never edits / never commits")
  for (const denied of [
    "write_file",
    "edit_file",
    "multi_edit",
    "apply_patch",
    "scaffold",
    "smoke_run",
    "git_commit",
    "git_push",
    "git_add",
    "create_pr",
    "task",
  ]) {
    expect(names.has(denied)).toBe(false);
  }
});
