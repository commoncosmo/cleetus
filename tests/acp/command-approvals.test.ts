import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { clientSupportsForms } from "../../src/acp/capabilities";
import { createAcpCommandHandler } from "../../src/acp/commands";
import {
  type PermissionClient,
  type SessionGrants,
  makeAcpResolvePermission,
} from "../../src/acp/permission";
import { updateCommandApproval } from "../../src/permission/command-approvals";
import { buildCommandRule } from "../../src/permission/command-pattern";
import { loadPermissions, makeRulesForCwd } from "../../src/permission/loader";
import type { PermissionRule, PermissionRules } from "../../src/permission/types";
import { buildSkillRegistry } from "../../src/skills/registry";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cleetus-command-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
const grants = (): SessionGrants => ({
  tools: new Set(),
  prefixes: [],
  denials: [],
  bashCommands: [],
  jobScopes: [],
});
const request = (command = "bun test tests/a.ts", cwd?: string) => ({
  tool: "bash",
  args: { command, ...(cwd ? { cwd } : {}) },
  argsSummary: command,
});
const shell = "bash:/bin/bash";

test("ACP suggested patterns are session-scoped, reusable, and checked against denies", async () => {
  const root = fixture();
  const sessionRules: PermissionRule[] = [];
  let prompts = 0;
  const rules: PermissionRules = { project: [], global: [] };
  const resolver = makeAcpResolvePermission(
    {
      requestPermission: async (req) => {
        prompts++;
        if (prompts === 1)
          expect(req.options.find((o) => o.optionId === "allow_command_session")?.name).toContain(
            "bun test *",
          );
        expect(req.options.some((o) => o.optionId === "edit_command_pattern")).toBe(false);
        return {
          outcome: {
            outcome: "selected",
            optionId: prompts === 1 ? "allow_command_session" : "reject_once",
          },
        };
      },
    },
    "s",
    grants(),
    root,
    { commandRules: sessionRules, rules, shellIdentity: async () => shell },
  );
  expect(await resolver(request())).toBe("allow");
  expect(await resolver(request("bun test tests/b.ts"))).toBe("allow");
  expect(prompts).toBe(1);
  expect(await resolver(request("bun test tests/b.ts && other"))).toBe("deny");
  expect(await resolver(request("bun test tests/b.ts", "child"))).toBe("deny");
  rules.project.push({ tool: "bash", argsPattern: "bun test*", decision: "deny" });
  expect(await resolver(request())).toBe("deny");
  expect(sessionRules).toHaveLength(1);
});

test("saved scoped approvals work in ACP while legacy broad allows still prompt", async () => {
  const root = fixture();
  const context = { command: "bun test a", cwd: root, shell };
  const saved = { ...buildCommandRule("bun test *", context)!, decision: "allow" as const };
  let prompts = 0;
  const client: PermissionClient = {
    requestPermission: async () => {
      prompts++;
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
    },
  };
  const resolver = makeAcpResolvePermission(client, "s", grants(), root, {
    rules: { project: [saved], global: [] },
    shellIdentity: async () => shell,
  });
  expect(await resolver(request())).toBe("allow");
  expect(prompts).toBe(0);
  const otherShell = makeAcpResolvePermission(client, "s", grants(), root, {
    rules: { project: [saved], global: [] },
    shellIdentity: async () => "powershell:pwsh",
  });
  expect(await otherShell(request())).toBe("deny");
  const legacy = makeAcpResolvePermission(client, "s", grants(), root, {
    rules: { project: [{ tool: "bash", decision: "allow" }], global: [] },
    shellIdentity: async () => shell,
  });
  expect(await legacy(request())).toBe("deny");
  expect(prompts).toBe(2);
});

test("ACP forms collect a pattern but require a separate confirmation", async () => {
  const root = fixture();
  const sessionRules: PermissionRule[] = [];
  let prompts = 0;
  const resolver = makeAcpResolvePermission(
    {
      elicitCommandPattern: async () => {
        expect(sessionRules).toHaveLength(0);
        return { action: "accept", content: { pattern: "bun test tests/*.ts", scope: "session" } };
      },
      requestPermission: async (req) => {
        prompts++;
        if (prompts === 2) {
          expect(req.options[0]?.name).toContain("bun test tests/*.ts");
          expect(sessionRules).toHaveLength(0);
        }
        return {
          outcome: {
            outcome: "selected",
            optionId: prompts === 1 ? "edit_command_pattern" : "confirm_command_pattern",
          },
        };
      },
    },
    "s",
    grants(),
    root,
    { commandRules: sessionRules, shellIdentity: async () => shell },
  );
  expect(await resolver(request())).toBe("allow");
  expect(await resolver(request("bun test tests/b.ts"))).toBe("allow");
  expect(prompts).toBe(2);
  expect(sessionRules).toHaveLength(1);
});

test("declined, malformed, mismatched, unconfirmed and cancelled forms never grant", async () => {
  for (const response of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: null },
    { action: "accept", content: { pattern: "bun test *", scope: "everything" } },
    { action: "accept", content: { pattern: "bun test *", scope: ["global"] } },
    { action: "accept", content: { pattern: "git diff *", scope: "session" } },
    { action: "accept", content: { pattern: "bun test *; other", scope: "session" } },
    { action: "accept", content: { pattern: "bun test *", scope: "session" } },
  ]) {
    const root = fixture();
    const sessionRules: PermissionRule[] = [];
    let prompts = 0;
    const resolver = makeAcpResolvePermission(
      {
        elicitCommandPattern: async () => response,
        requestPermission: async () => ({
          outcome: {
            outcome: "selected",
            optionId: ++prompts === 1 ? "edit_command_pattern" : "reject_once",
          },
        }),
      },
      "s",
      grants(),
      root,
      { commandRules: sessionRules, shellIdentity: async () => shell },
    );
    expect(await resolver(request())).toBe("deny");
    expect(sessionRules).toHaveLength(0);
  }
  const root = fixture();
  const sessionRules: PermissionRule[] = [];
  const abort = new AbortController();
  const resolver = makeAcpResolvePermission(
    {
      elicitCommandPattern: async () => {
        abort.abort();
        return { action: "accept", content: { pattern: "bun test *", scope: "session" } };
      },
      requestPermission: async () => ({
        outcome: { outcome: "selected", optionId: "edit_command_pattern" },
      }),
    },
    "s",
    grants(),
    root,
    { commandRules: sessionRules, shellIdentity: async () => shell, signal: abort.signal },
  );
  await expect(resolver(request())).rejects.toBeDefined();
  expect(sessionRules).toHaveLength(0);
});

test("saved command rules round-trip, deduplicate by scope, and can be removed", async () => {
  const root = fixture();
  const globalPath = join(root, "permissions.yaml");
  const rules: PermissionRules = { project: [], global: [] };
  const sessionRules: PermissionRule[] = [];
  const store = { rules, sessionRules, projectDir: root, globalPath };
  const rule = buildCommandRule("bun test *", { command: "bun test a", cwd: root, shell })!;
  await updateCommandApproval(store, rule, "global");
  await updateCommandApproval(store, rule, "global");
  expect(rules.global).toHaveLength(1);
  const loaded = await loadPermissions({ projectDir: root, globalPath });
  expect(loaded.global).toEqual(rules.global);
  await updateCommandApproval(store, rule, "session");
  await updateCommandApproval(store, rule, "session", true);
  expect(sessionRules).toHaveLength(0);
  await updateCommandApproval(store, rule, "global", true);
  expect((await loadPermissions({ projectDir: root, globalPath })).global).toHaveLength(0);
  expect(rules.global).toHaveLength(0);
}, 30000);

test("project approvals are trusted on reload and persistence failure does not grant", async () => {
  const root = fixture();
  const projectDir = join(root, "repo");
  mkdirSync(projectDir);
  const globalConfigPath = join(root, "global", "config.yaml");
  const globalPath = join(root, "global", "permissions.yaml");
  const persistPath = join(projectDir, ".cleetus", "permissions.yaml");
  const rules: PermissionRules = { project: [], global: [] };
  const sessionRules: PermissionRule[] = [];
  const rule = buildCommandRule("bun test *", { command: "bun test a", cwd: projectDir, shell })!;
  const store = { rules, sessionRules, projectDir, persistPath, globalPath, globalConfigPath };
  await updateCommandApproval(store, rule, "project");
  expect((await loadPermissions({ projectDir, globalPath })).project).toEqual(rules.project);
  await updateCommandApproval(store, rule, "project", true);
  expect((await loadPermissions({ projectDir, globalPath })).project).toHaveLength(0);
  await expect(
    updateCommandApproval({ ...store, globalPath: root }, rule, "global"),
  ).rejects.toBeDefined();
  expect(rules.global).toHaveLength(0);
  // Incomplete or ambiguous command metadata must fail validation, never become a broad allow.
  writeFileSync(
    globalPath,
    'rules:\n  - tool: bash\n    command_pattern: "bun test *"\n    decision: allow\n',
  );
  await expect(loadPermissions({ projectDir, globalPath })).rejects.toThrow(
    "command rules require",
  );
}, 30000);

test("form support requires an explicit non-null capability object", () => {
  for (const caps of [
    {},
    { elicitation: {} },
    { elicitation: null },
    { elicitation: { form: null } },
  ])
    expect(clientSupportsForms(caps)).toBe(false);
  expect(clientSupportsForms({ elicitation: { form: {} } })).toBe(true);
});

test("global approval removal reaches every cached ACP project in this connection", async () => {
  const root = fixture();
  const a = join(root, "a");
  const b = join(root, "b");
  mkdirSync(a);
  mkdirSync(b);
  const globalPath = join(root, "permissions.yaml");
  const load = makeRulesForCwd(globalPath);
  const rulesA = await load(a);
  const rulesB = await load(b);
  const alias = join(root, "alias");
  symlinkSync(a, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await load(alias)).toBe(rulesA);
  if (process.platform === "win32") expect(await load(a.toUpperCase())).toBe(rulesA);
  const rule = buildCommandRule("bun test *", { command: "bun test a", cwd: a, shell })!;
  const store = { rules: rulesA, sessionRules: [], projectDir: a, globalPath };
  await updateCommandApproval(store, rule, "global");
  expect(rulesB.global).toHaveLength(1);
  await updateCommandApproval(store, rule, "global", true);
  expect(rulesB.global).toHaveLength(0);
}, 30000);

test("ACP /permissions preserves custom patterns, scope and removal requests", async () => {
  const calls: unknown[] = [];
  const handler = createAcpCommandHandler(buildSkillRegistry([], []), {
    getPermissions: async () => ({ project: [], global: [] }),
    getSessionCommandRules: () => [
      {
        tool: "bash",
        commandPattern: "bun test *",
        commandCwd: "/repo",
        commandShell: shell,
        decision: "allow",
      },
    ],
    updateCommandApproval: async (...args) => {
      calls.push(args);
      return "updated";
    },
  });
  expect(
    await handler.execute(
      '/permissions allow session bun test "tests/a file.ts" * --timeout 30000',
      { sessionId: "one" },
    ),
  ).toEqual({ kind: "text", text: "updated" });
  expect(
    await handler.execute("/permissions remove global bun test *", { sessionId: "two" }),
  ).toEqual({ kind: "text", text: "updated" });
  expect(calls).toEqual([
    ["one", 'bun test "tests/a file.ts" * --timeout 30000', "session", false],
    ["two", "bun test *", "global", true],
  ]);
  expect(JSON.stringify(await handler.execute("/permissions", { sessionId: "one" }))).toContain(
    "session commands",
  );
  expect(
    JSON.stringify(
      await handler.execute("/permissions allow everywhere bun test *", { sessionId: "one" }),
    ),
  ).toContain("usage:");
  expect(calls).toHaveLength(2);
});
