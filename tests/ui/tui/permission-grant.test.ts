import { describe, expect, it } from "bun:test";
import { addRule } from "../../../src/permission/grant";
import type { PermissionRules } from "../../../src/permission/types";
import {
  buildGrantRule,
  defaultGrantInput,
  readEscapeQuickGrant,
} from "../../../src/ui/tui/permission-grant";

describe("defaultGrantInput", () => {
  it("returns the command for bash", () => {
    expect(defaultGrantInput("bash", "git push origin main")).toBe("git push origin main");
  });
  it("returns the target's parent dir for write tools", () => {
    expect(defaultGrantInput("edit_file", "edit_file /p/src/a.ts", "/p/src/a.ts")).toBe("/p/src");
    expect(defaultGrantInput("apply_patch", "apply_patch /p/src/a.ts", "/p/src/a.ts")).toBe(
      "/p/src",
    );
  });
  it("returns null for a write tool without a targetPath", () => {
    expect(defaultGrantInput("edit_file", "edit_file a.ts")).toBeNull();
  });
  it("returns null for tools that can't be broadened", () => {
    expect(defaultGrantInput("bash_history", "bash_history", "/p/a.ts")).toBeNull();
  });
});

describe("buildGrantRule", () => {
  it("builds a bash argsPattern rule with a trailing star ensured", () => {
    expect(buildGrantRule("bash", "git push")).toEqual({ tool: "bash", argsPattern: "git push*" });
  });
  it("does not double the trailing star", () => {
    expect(buildGrantRule("bash", "git push*")).toEqual({ tool: "bash", argsPattern: "git push*" });
  });
  it("builds a pathPrefix rule for write tools", () => {
    expect(buildGrantRule("edit_file", "/p/src")).toEqual({ pathPrefix: "/p/src" });
  });
  it("returns null for empty input or unsupported tools", () => {
    expect(buildGrantRule("bash", "   ")).toBeNull();
    expect(buildGrantRule("bash_history", "/p")).toBeNull();
  });
});

describe("read-tool directory grants", () => {
  it("prefills the parent dir for read_file, the dir itself for glob/grep", () => {
    expect(
      defaultGrantInput("read_file", "read_file /opt/reg/pkg/mod.rs", "/opt/reg/pkg/mod.rs"),
    ).toBe("/opt/reg/pkg");
    expect(defaultGrantInput("glob", "glob *", "/opt/reg/pkg")).toBe("/opt/reg/pkg");
    expect(defaultGrantInput("grep", "grep x", "/opt/reg/pkg")).toBe("/opt/reg/pkg");
  });

  it("builds a pathPrefix rule for read tools", () => {
    expect(buildGrantRule("read_file", "/opt/reg")).toEqual({ pathPrefix: "/opt/reg" });
    expect(buildGrantRule("grep", "/opt/reg")).toEqual({ pathPrefix: "/opt/reg" });
  });

  it('composed with addRule(..., "deny") persists the same pathPrefix deny rule the ' +
    "readEscape never-flow builds", () => {
    const rule = buildGrantRule("read_file", "/opt/reg");
    expect(rule).not.toBeNull();
    const rules: PermissionRules = { project: [], global: [] };
    addRule(rules, "project", rule!, "deny");
    expect(rules.project).toEqual([{ pathPrefix: "/opt/reg", decision: "deny" }]);
  });
});

describe("readEscapeQuickGrant", () => {
  it("scopes read_file's quick-grant to the parent dir (never a whole-tool allow)", () => {
    expect(readEscapeQuickGrant("read_file", "read_file /opt/reg/pkg", "/opt/reg/pkg")).toEqual({
      pathPrefix: "/opt/reg",
    });
  });

  it("scopes glob/grep's quick-grant to the target dir itself", () => {
    expect(readEscapeQuickGrant("glob", "glob *", "/opt/reg/pkg")).toEqual({
      pathPrefix: "/opt/reg/pkg",
    });
    expect(readEscapeQuickGrant("grep", "grep x", "/opt/reg/pkg")).toEqual({
      pathPrefix: "/opt/reg/pkg",
    });
  });

  it("returns null when no targetPath is known (no prefill to derive a scope from)", () => {
    expect(readEscapeQuickGrant("read_file", "read_file x")).toBeNull();
  });
});
