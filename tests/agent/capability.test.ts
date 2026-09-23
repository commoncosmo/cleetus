import { describe, expect, it } from "bun:test";
import {
  CLIENT_JOB_TOOL_ROSTER,
  EXACT_ARTIFACT_TOOL_ROSTER,
  SMALL_RETRIEVAL_TOOL_ROSTER,
  SMALL_TOOL_ROSTER,
  decideCapability,
  filterToolsForCapability,
  hiddenToolRedirect,
} from "../../src/agent/capability";
import type { Tool, ToolResult } from "../../src/tools/types";

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    mutates: false,
    parameters: { type: "object", properties: {} },
    serialize: () => name,
    run: async (): Promise<ToolResult> => ({ ok: true, output: "" }),
  };
}

describe("decideCapability", () => {
  it("small when the window is below the low-context threshold", () => {
    expect(decideCapability(8192)).toBe("small");
    expect(decideCapability(16383)).toBe("small");
  });
  it("small when the window is unknown (conservative, mirrors WS1.3)", () => {
    expect(decideCapability(undefined)).toBe("small");
  });
  it("standard at or above the threshold", () => {
    expect(decideCapability(16384)).toBe("standard");
    expect(decideCapability(131072)).toBe("standard");
  });
});

describe("filterToolsForCapability", () => {
  const names = [
    "read_file",
    "write_file",
    "edit_file",
    "bash",
    "grep",
    "glob",
    "todo_write",
    "record_findings",
    "run_tests",
    "scaffold",
    "multi_edit",
    "apply_patch",
    "smoke_run",
    "render_check",
    "task",
    "remember",
    "todo_list_show",
    "git_status",
    "create_pr",
    "web_fetch",
    "code_search",
    "mcp__jira__create_issue",
    "job_start",
    "job_status",
    "job_cancel",
    "job_artifact_read",
    "job_artifact_normalize",
  ];
  const tools = names.map(fakeTool);

  it("standard passes every tool through unchanged", () => {
    expect(filterToolsForCapability(tools, "standard")).toEqual(tools);
  });
  it("small keeps exactly the roster plus negotiated external tools", () => {
    const kept = filterToolsForCapability(tools, "small").map((t) => t.name);
    expect(kept.sort()).toEqual(
      [...SMALL_TOOL_ROSTER, ...CLIENT_JOB_TOOL_ROSTER, "mcp__jira__create_issue"].sort(),
    );
  });
  it("small admits only the task-scoped retrieval additions when requested", () => {
    const kept = filterToolsForCapability(tools, "small", SMALL_RETRIEVAL_TOOL_ROSTER).map(
      (t) => t.name,
    );
    expect(kept).toContain("web_fetch");
    expect(kept).not.toContain("code_search");
  });
  it("the small roster includes dedicated verification tools", () => {
    expect([...SMALL_TOOL_ROSTER].sort()).toEqual([
      "bash",
      "edit_file",
      "glob",
      "grep",
      "read_file",
      "record_findings",
      "render_check",
      "run_tests",
      "scaffold",
      "smoke_run",
      "todo_write",
      "write_file",
    ]);
  });
  it("exact artifacts expose retrieval, exact save, and safe inspection without generic writers", () => {
    expect([...EXACT_ARTIFACT_TOOL_ROSTER].sort()).toEqual([
      "grep",
      "read_file",
      "save_fetched_json",
      "web_fetch",
      "web_search",
    ]);
    expect(EXACT_ARTIFACT_TOOL_ROSTER.has("bash")).toBe(false);
    expect(EXACT_ARTIFACT_TOOL_ROSTER.has("write_file")).toBe(false);
  });
});

describe("hiddenToolRedirect", () => {
  it("null for standard capability, roster tools, and negotiated external tools", () => {
    expect(hiddenToolRedirect("apply_patch", "standard")).toBeNull();
    expect(hiddenToolRedirect("edit_file", "small")).toBeNull();
    expect(hiddenToolRedirect("mcp__jira__create_issue", "small")).toBeNull();
    expect(hiddenToolRedirect("job_start", "small")).toBeNull();
  });
  it("null for a task-scoped small-surface tool", () => {
    expect(hiddenToolRedirect("web_fetch", "small", SMALL_RETRIEVAL_TOOL_ROSTER)).toBeNull();
  });
  it("edit-family redirects to edit_file", () => {
    expect(hiddenToolRedirect("multi_edit", "small")).toBe(
      "multi_edit is not available in this session; use edit_file.",
    );
    expect(hiddenToolRedirect("apply_patch", "small")).toBe(
      "apply_patch is not available in this session; use edit_file.",
    );
  });
  it("git family (including create_pr) redirects to bash", () => {
    for (const n of [
      "git_status",
      "git_diff",
      "git_log",
      "git_add",
      "git_commit",
      "git_push",
      "create_pr",
    ]) {
      expect(hiddenToolRedirect(n, "small")).toBe(
        `${n} is not available in this session; run the git/gh command with bash.`,
      );
    }
  });
  it("todo_list family redirects to todo_write", () => {
    for (const n of [
      "todo_list_show",
      "todo_list_write",
      "todo_list_delete",
      "todo_list_save",
      "todo_list_load",
    ]) {
      expect(hiddenToolRedirect(n, "small")).toBe(
        `${n} is not available in this session; use todo_write for the working todo list.`,
      );
    }
  });
  it("keeps purpose-built launch and render verification available", () => {
    expect(hiddenToolRedirect("smoke_run", "small")).toBeNull();
    expect(hiddenToolRedirect("render_check", "small")).toBeNull();
  });
  it("plain unavailability for the rest", () => {
    for (const n of ["web_fetch", "web_search", "code_search", "remember", "task"]) {
      expect(hiddenToolRedirect(n, "small")).toBe(`${n} is not available in this session.`);
    }
  });
});
