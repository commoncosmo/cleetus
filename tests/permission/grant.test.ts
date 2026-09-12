import { describe, expect, it } from "bun:test";
import { evaluatePermission } from "../../src/permission/evaluator";
import { addAllowRule, addRule } from "../../src/permission/grant";
import type { PermissionRules } from "../../src/permission/types";

const empty = (): PermissionRules => ({ project: [], global: [] });

describe("addAllowRule", () => {
  it("makes a tool resolve to allow after a project grant (was the default ask)", () => {
    const rules = empty();
    // edit_file defaults to "ask" with no rules.
    expect(evaluatePermission(rules, "edit_file", "edit_file foo.ts")).toBe("ask");
    addAllowRule(rules, "project", "edit_file");
    // After the grant, the running session should honor it for any args.
    expect(evaluatePermission(rules, "edit_file", "edit_file foo.ts")).toBe("allow");
    expect(evaluatePermission(rules, "edit_file", "edit_file other.ts")).toBe("allow");
  });

  it("pushes a tool-level allow (no args pattern) into the project layer", () => {
    const rules = empty();
    addAllowRule(rules, "project", "write_file");
    expect(rules.project).toEqual([{ tool: "write_file", decision: "allow" }]);
    expect(rules.global).toEqual([]);
  });

  it("pushes into the global layer for a global grant", () => {
    const rules = empty();
    addAllowRule(rules, "global", "bash");
    expect(rules.global).toEqual([{ tool: "bash", decision: "allow" }]);
    expect(rules.project).toEqual([]);
  });
});

describe("addRule", () => {
  it("adds an argsPattern allow rule", () => {
    const r = empty();
    addRule(r, "project", { tool: "bash", argsPattern: "git push*" });
    expect(r.project).toEqual([{ tool: "bash", argsPattern: "git push*", decision: "allow" }]);
  });
  it("adds a pathPrefix allow rule (no tool)", () => {
    const r = empty();
    addRule(r, "global", { pathPrefix: "/proj/src" });
    expect(r.global).toEqual([{ pathPrefix: "/proj/src", decision: "allow" }]);
  });
  it("dedupes on the full shape", () => {
    const r = empty();
    addRule(r, "project", { pathPrefix: "/proj/src" });
    addRule(r, "project", { pathPrefix: "/proj/src" });
    expect(r.project).toHaveLength(1);
  });
  it("keeps rules that differ only in argsPattern (no false dedup across shapes)", () => {
    const r = empty();
    addRule(r, "project", { tool: "bash" });
    addRule(r, "project", { tool: "bash", argsPattern: "git push*" });
    expect(r.project).toHaveLength(2);
  });
});

describe("addAllowRule (tool-level wrapper)", () => {
  it("adds a tool-level allow", () => {
    const r = empty();
    addAllowRule(r, "project", "edit_file");
    expect(r.project).toEqual([{ tool: "edit_file", decision: "allow" }]);
  });
});

describe("addAllowRule de-dup", () => {
  it("does not add a duplicate identical rule", () => {
    const rules: PermissionRules = { project: [], global: [] };
    addAllowRule(rules, "project", "write_file");
    addAllowRule(rules, "project", "write_file");
    expect(rules.project).toHaveLength(1);
  });

  it("adds a rule for a different tool", () => {
    const rules: PermissionRules = { project: [], global: [] };
    addAllowRule(rules, "project", "write_file");
    addAllowRule(rules, "project", "bash");
    expect(rules.project).toHaveLength(2);
  });
});

describe("addRule with an explicit decision", () => {
  it("appends a deny rule and dedupes on shape+decision", () => {
    const rules: PermissionRules = { project: [], global: [] };
    addRule(rules, "project", { tool: "bash", argsPattern: "rm -rf*" }, "deny");
    addRule(rules, "project", { tool: "bash", argsPattern: "rm -rf*" }, "deny");
    expect(rules.project).toEqual([{ tool: "bash", argsPattern: "rm -rf*", decision: "deny" }]);
  });

  it("an allow and a deny of the same shape are distinct entries", () => {
    const rules: PermissionRules = { project: [], global: [] };
    addRule(rules, "project", { tool: "bash", argsPattern: "git push*" }); // default allow
    addRule(rules, "project", { tool: "bash", argsPattern: "git push*" }, "deny");
    expect(rules.project).toHaveLength(2);
  });
});
