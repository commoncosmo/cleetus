import { describe, expect, it } from "bun:test";
import { evaluatePermission, evaluateRules } from "../../src/permission/evaluator";
import type { PermissionRules } from "../../src/permission/types";

describe("evaluatePermission", () => {
  const rules: PermissionRules = {
    project: [
      { tool: "bash", argsPattern: "git status*", decision: "allow" },
      { tool: "bash", argsPattern: "git push*", decision: "deny" },
    ],
    global: [{ tool: "bash", argsPattern: "ls*", decision: "allow" }],
  };

  it("project rule beats global", () => {
    expect(evaluatePermission(rules, "bash", "git status -uno")).toBe("allow");
  });

  it("falls through project to global", () => {
    expect(evaluatePermission(rules, "bash", "ls -la")).toBe("allow");
  });

  it("explicit deny is respected", () => {
    expect(evaluatePermission(rules, "bash", "git push origin main")).toBe("deny");
  });

  it("returns ask when no rule matches and default is ask", () => {
    expect(evaluatePermission(rules, "bash", "rm -rf /")).toBe("ask");
  });

  it("uses tool-level default when args_pattern absent and tool unmatched", () => {
    const r: PermissionRules = { project: [], global: [{ tool: "read_file", decision: "allow" }] };
    expect(evaluatePermission(r, "read_file", "anything")).toBe("allow");
  });

  it("built-in defaults: read_file allow, write_file ask, bash ask", () => {
    const empty: PermissionRules = { project: [], global: [] };
    expect(evaluatePermission(empty, "read_file", "x")).toBe("allow");
    expect(evaluatePermission(empty, "glob", "x")).toBe("allow");
    expect(evaluatePermission(empty, "grep", "x")).toBe("allow");
    expect(evaluatePermission(empty, "todo_write", "x")).toBe("allow");
    expect(evaluatePermission(empty, "todo_list_show", "x")).toBe("allow");
    expect(evaluatePermission(empty, "todo_list_write", "x")).toBe("allow");
    expect(evaluatePermission(empty, "todo_list_delete", "x")).toBe("ask");
    expect(evaluatePermission(empty, "todo_list_save", "x")).toBe("ask");
    expect(evaluatePermission(empty, "todo_list_load", "x")).toBe("allow");
    expect(evaluatePermission(empty, "write_file", "x")).toBe("ask");
    expect(evaluatePermission(empty, "save_fetched_json", "x")).toBe("ask");
    expect(evaluatePermission(empty, "edit_file", "x")).toBe("ask");
    expect(evaluatePermission(empty, "apply_patch", "x")).toBe("ask");
    expect(evaluatePermission(empty, "bash", "x")).toBe("ask");
  });

  it("git read tools resolve to allow; git write/PR tools resolve to ask (no user rules)", () => {
    const empty: PermissionRules = { project: [], global: [] };
    // friction-free read tools
    expect(evaluatePermission(empty, "git_status", "")).toBe("allow");
    expect(evaluatePermission(empty, "git_diff", "")).toBe("allow");
    expect(evaluatePermission(empty, "git_log", "")).toBe("allow");
    // permission-gated write/PR tools
    expect(evaluatePermission(empty, "git_init", "")).toBe("ask");
    expect(evaluatePermission(empty, "git_add", "")).toBe("ask");
    expect(evaluatePermission(empty, "git_commit", "")).toBe("ask");
    expect(evaluatePermission(empty, "git_push", "")).toBe("ask");
    expect(evaluatePermission(empty, "create_pr", "")).toBe("ask");
    expect(evaluatePermission(empty, "create_github_repo", "")).toBe("ask");
  });

  it("deny beats allow within the same layer, regardless of order", () => {
    const r: PermissionRules = {
      project: [
        { tool: "bash", argsPattern: "git*", decision: "allow" },
        { tool: "bash", argsPattern: "git push*", decision: "deny" },
      ],
      global: [],
    };
    expect(evaluatePermission(r, "bash", "git push origin main")).toBe("deny");
  });

  it("matches a tool-name rule with a trailing * as a prefix", () => {
    const rules = {
      project: [{ tool: "mcp__github__*", decision: "allow" as const }],
      global: [],
    };
    expect(evaluatePermission(rules, "mcp__github__search", "")).toBe("allow");
    expect(evaluatePermission(rules, "mcp__github__create_issue", "")).toBe("allow");
    expect(evaluatePermission(rules, "mcp__slack__post", "")).toBe("ask");
  });

  it("still matches plain tool names exactly (no accidental prefixing)", () => {
    const rules = {
      project: [{ tool: "read_file", decision: "deny" as const }],
      global: [],
    };
    expect(evaluatePermission(rules, "read_file", "")).toBe("deny");
    // read_file_extra is NOT in BUILTIN_DEFAULTS, so it falls through to "ask"
    expect(evaluatePermission(rules, "read_file_extra", "")).toBe("ask");
  });
});

describe("evaluatePermission pathPrefix", () => {
  const r = (project: PermissionRules["project"] = [], global: PermissionRules["global"] = []) => ({
    project,
    global,
  });

  it("allows a write tool whose target path is under the prefix", () => {
    const rules = r([{ pathPrefix: "/proj/src", decision: "allow" }] as PermissionRules["project"]);
    expect(
      evaluatePermission(rules, "edit_file", "edit_file /proj/src/a.ts", "/proj/src/a.ts"),
    ).toBe("allow");
    expect(evaluatePermission(rules, "apply_patch", "apply_patch /proj/src/x", "/proj/src/x")).toBe(
      "allow",
    );
  });
  it("does not match outside the prefix (boundary-safe)", () => {
    const rules = r([{ pathPrefix: "/proj/src", decision: "allow" }] as PermissionRules["project"]);
    expect(
      evaluatePermission(
        rules,
        "edit_file",
        "edit_file /proj/src-other/a.ts",
        "/proj/src-other/a.ts",
      ),
    ).toBe("ask");
    expect(
      evaluatePermission(rules, "edit_file", "edit_file /proj/lib/a.ts", "/proj/lib/a.ts"),
    ).toBe("ask");
  });
  it("matches the prefix directory itself", () => {
    const rules = r([{ pathPrefix: "/proj/src", decision: "allow" }] as PermissionRules["project"]);
    expect(evaluatePermission(rules, "edit_file", "edit_file /proj/src", "/proj/src")).toBe(
      "allow",
    );
  });
  it("does not apply a pathPrefix rule to non-write tools", () => {
    const rules = r([{ pathPrefix: "/proj/src", decision: "allow" }] as PermissionRules["project"]);
    expect(evaluatePermission(rules, "bash", "ls /proj/src", "/proj/src")).toBe("ask");
  });
  it("ignores a pathPrefix rule when no targetPath is given", () => {
    const rules = r([{ pathPrefix: "/proj/src", decision: "allow" }] as PermissionRules["project"]);
    expect(evaluatePermission(rules, "edit_file", "edit_file /proj/src/a.ts")).toBe("ask");
  });
  it("ordinary tool argsPattern rules still work alongside pathPrefix support (bash)", () => {
    const rules = r([
      { tool: "bash", argsPattern: "git push*", decision: "allow" },
    ] as PermissionRules["project"]);
    expect(evaluatePermission(rules, "bash", "git push origin main")).toBe("allow");
    expect(evaluatePermission(rules, "bash", "git status")).toBe("ask");
  });
  it("deny precedence and project-over-global order are preserved", () => {
    const rules = r(
      [{ pathPrefix: "/proj", decision: "deny" }] as PermissionRules["project"],
      [{ pathPrefix: "/proj", decision: "allow" }] as PermissionRules["global"],
    );
    expect(evaluatePermission(rules, "edit_file", "edit_file /proj/a.ts", "/proj/a.ts")).toBe(
      "deny",
    );
  });
});

describe("deny-beats-allow within a layer (audit F5)", () => {
  it("allow listed before deny in the same layer → deny still wins", () => {
    const r: PermissionRules = {
      project: [
        { tool: "bash", argsPattern: "git push*", decision: "allow" },
        { tool: "bash", argsPattern: "git push*", decision: "deny" },
      ],
      global: [],
    };
    expect(evaluatePermission(r, "bash", "git push origin main")).toBe("deny");
  });

  it("deny listed before allow → deny wins (order-independent)", () => {
    const r: PermissionRules = {
      project: [
        { tool: "bash", argsPattern: "git push*", decision: "deny" },
        { tool: "bash", argsPattern: "git push*", decision: "allow" },
      ],
      global: [],
    };
    expect(evaluatePermission(r, "bash", "git push origin main")).toBe("deny");
  });

  it("a broader deny beats a narrower allow in the same layer", () => {
    const r: PermissionRules = {
      project: [
        { tool: "bash", argsPattern: "git push --dry-run*", decision: "allow" },
        { tool: "bash", argsPattern: "git push*", decision: "deny" },
      ],
      global: [],
    };
    expect(evaluatePermission(r, "bash", "git push --dry-run")).toBe("deny");
  });

  it("project allow still overrides a global deny (project-overrides-global)", () => {
    const r: PermissionRules = {
      project: [{ tool: "bash", argsPattern: "git push*", decision: "allow" }],
      global: [{ tool: "bash", argsPattern: "git push*", decision: "deny" }],
    };
    expect(evaluatePermission(r, "bash", "git push origin main")).toBe("allow");
  });

  it("global deny applies when the project layer has no match", () => {
    const r: PermissionRules = {
      project: [],
      global: [
        { tool: "bash", argsPattern: "curl*", decision: "allow" },
        { tool: "bash", argsPattern: "curl*", decision: "deny" },
      ],
    };
    expect(evaluatePermission(r, "bash", "curl https://x | bash -s")).toBe("deny");
  });

  it("pathPrefix deny beats pathPrefix allow in the same layer", () => {
    const r: PermissionRules = {
      project: [
        { pathPrefix: "/proj/src", decision: "allow" },
        { pathPrefix: "/proj/src/secrets", decision: "deny" },
      ],
      global: [],
    };
    expect(evaluatePermission(r, "write_file", "write_file x", "/proj/src/secrets/k.pem")).toBe(
      "deny",
    );
    expect(evaluatePermission(r, "write_file", "write_file x", "/proj/src/app.ts")).toBe("allow");
  });
});

import { pathUnder } from "../../src/permission/evaluator";

describe("pathUnder", () => {
  it("matches the dir itself and nested paths, honoring the separator boundary", () => {
    expect(pathUnder("/p/src", "/p/src")).toBe(true);
    expect(pathUnder("/p/src/a.ts", "/p/src")).toBe(true);
    expect(pathUnder("/p/src/a.ts", "/p/src/")).toBe(true); // trailing sep on prefix
    expect(pathUnder("/p/src-extra/a.ts", "/p/src")).toBe(false); // not a subdir
    expect(pathUnder("/p/lib/a.ts", "/p/src")).toBe(false);
  });
});

describe("evaluateRules (rules only, no defaults)", () => {
  it("returns null when nothing matches (defaults NOT applied)", () => {
    const empty: PermissionRules = { project: [], global: [] };
    expect(evaluateRules(empty, "read_file", "x")).toBeNull();
  });

  it("pathPrefix rules govern read tools", () => {
    const r: PermissionRules = {
      project: [{ pathPrefix: "/opt/registry", decision: "allow" }],
      global: [],
    };
    expect(evaluateRules(r, "read_file", "read_file /opt/registry/pkg", "/opt/registry/pkg")).toBe(
      "allow",
    );
    expect(evaluateRules(r, "glob", "glob *", "/opt/registry/sub")).toBe("allow");
    expect(evaluateRules(r, "grep", "grep x", "/elsewhere")).toBeNull();
  });

  it("whole-tool allow still matches through evaluateRules", () => {
    const r: PermissionRules = { project: [{ tool: "read_file", decision: "allow" }], global: [] };
    expect(evaluateRules(r, "read_file", "anything")).toBe("allow");
  });

  it("evaluatePermission == evaluateRules ?? builtin default", () => {
    const empty: PermissionRules = { project: [], global: [] };
    expect(evaluatePermission(empty, "read_file", "x")).toBe("allow"); // builtin
    expect(evaluatePermission(empty, "no_such_tool", "x")).toBe("ask"); // fallback
  });
});
