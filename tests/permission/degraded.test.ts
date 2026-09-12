import { describe, expect, it } from "bun:test";
import { stripBashAllowRules } from "../../src/permission/degraded";
import type { PermissionRules } from "../../src/permission/types";

const ROSTER = ["bash", "read_file", "write_file", "git_status", "web_fetch"];

describe("stripBashAllowRules", () => {
  it("removes exact bash allow rules, keeps deny/ask and non-bash rules", () => {
    const rules: PermissionRules = {
      project: [
        { tool: "bash", decision: "allow" },
        { tool: "bash", argsPattern: "bun test*", decision: "allow" },
        { tool: "bash", argsPattern: "rm -rf*", decision: "deny" },
        { tool: "write_file", decision: "allow" },
      ],
      global: [
        { tool: "git_status", decision: "allow" },
        { pathPrefix: "/proj/src", decision: "allow" },
      ],
    };
    stripBashAllowRules(rules, ROSTER);
    expect(rules.project).toEqual([
      { tool: "bash", argsPattern: "rm -rf*", decision: "deny" },
      { tool: "write_file", decision: "allow" },
    ]);
    expect(rules.global).toEqual([
      { tool: "git_status", decision: "allow" },
      { pathPrefix: "/proj/src", decision: "allow" },
    ]);
  });

  it("expands a wildcard allow into per-tool allows for every roster tool except bash", () => {
    const rules: PermissionRules = {
      project: [{ tool: "*", decision: "allow" }],
      global: [],
    };
    stripBashAllowRules(rules, ROSTER);
    expect(rules.project).toEqual([
      { tool: "read_file", decision: "allow" },
      { tool: "write_file", decision: "allow" },
      { tool: "git_status", decision: "allow" },
      { tool: "web_fetch", decision: "allow" },
    ]);
  });

  it("expansion preserves argsPattern and pathPrefix", () => {
    const rules: PermissionRules = {
      project: [{ tool: "*", argsPattern: "x*", pathPrefix: "/p", decision: "allow" }],
      global: [],
    };
    stripBashAllowRules(rules, ["bash", "grep"]);
    expect(rules.project).toEqual([
      { tool: "grep", argsPattern: "x*", pathPrefix: "/p", decision: "allow" },
    ]);
  });

  it("a prefix pattern matching only bash is removed with no expansion", () => {
    const rules: PermissionRules = {
      project: [{ tool: "ba*", decision: "allow" }],
      global: [],
    };
    stripBashAllowRules(rules, ROSTER);
    expect(rules.project).toEqual([]);
  });

  it("wildcard deny rules pass through untouched", () => {
    const rules: PermissionRules = {
      project: [{ tool: "*", decision: "deny" }],
      global: [],
    };
    stripBashAllowRules(rules, ROSTER);
    expect(rules.project).toEqual([{ tool: "*", decision: "deny" }]);
  });

  it("mutates in place (closures holding the rules object see the strip)", () => {
    const rules: PermissionRules = {
      project: [{ tool: "bash", decision: "allow" }],
      global: [],
    };
    const alias = rules;
    stripBashAllowRules(rules, ROSTER);
    expect(alias.project).toEqual([]);
  });
});
