import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loader";
import { loadPermissions } from "../../src/permission/loader";
import { persistRule } from "../../src/permission/persist";
import {
  approveProjectConfiguration,
  projectConfigurationSnapshot,
} from "../../src/security/project-trust";

let root: string;
let opts: { projectDir: string; globalPath: string };
let config: string;
let permissions: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cleetus-trust-")));
  opts = { projectDir: join(root, "project"), globalPath: join(root, "global", "config.yaml") };
  await mkdir(join(opts.projectDir, ".cleetus"), { recursive: true });
  config = join(opts.projectDir, ".cleetus", "config.yaml");
  permissions = join(opts.projectDir, ".cleetus", "permissions.yaml");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("first use still requires trust, even for tuning-only configuration", async () => {
  await writeFile(config, "default_effort: low\n");
  await expect(loadConfig(opts)).rejects.toThrow("Untrusted project configuration");
});

test("comments, map order and tuning changes preserve approved authority", async () => {
  await writeFile(config, "default_effort: low\nsandbox: { backend: host, network: false }\n");
  await approveProjectConfiguration(opts);
  await writeFile(
    config,
    "# edited\nsandbox: { network: false, backend: host }\ndefault_effort: high\nstreaming: { enabled: false }\nui: { theme: light }\n",
  );
  const loaded = await loadConfig(opts);
  expect(loaded.defaultEffort).toBe("high");
  expect(loaded.streaming.enabled).toBe(false);
  expect(loaded.ui.theme).toBe("light");
});

for (const edit of [
  "permissions_disabled: true",
  "sandbox: { backend: none }",
  "mcp_servers: { injected: { command: sh } }",
  "default_provider: other",
  "default_model: other",
  "system_prompt_file: instructions.txt",
  "hooks: [{ event: pre_tool_use, command: injected }]",
  "future_authority: true",
]) {
  test(`authority change requires reapproval: ${edit}`, async () => {
    await writeFile(config, "default_effort: low\n");
    await approveProjectConfiguration(opts);
    await writeFile(config, `default_effort: high\n${edit}\n`);
    await expect(loadConfig(opts)).rejects.toThrow("Untrusted project configuration");
  });
}

test("permission formatting preserves trust, rule order and decisions do not", async () => {
  await writeFile(permissions, "rules: [{tool: bash, decision: deny}, {decision: ask}]\n");
  await approveProjectConfiguration(opts);
  await writeFile(
    permissions,
    "# comment\nrules:\n  - decision: deny\n    tool: bash\n  - decision: ask\n",
  );
  expect((await loadPermissions(opts)).project[0]?.decision).toBe("deny");
  await writeFile(permissions, "rules: [{decision: ask}, {tool: bash, decision: deny}]\n");
  await expect(loadPermissions(opts)).rejects.toThrow("Untrusted");
});

test("invalid YAML never matches an approved configuration", async () => {
  await writeFile(config, "default_effort: low\n");
  await approveProjectConfiguration(opts);
  await writeFile(config, "ui: [\n");
  await expect(loadConfig(opts)).rejects.toThrow("Untrusted");
});

test("approval rejects any byte change after the displayed snapshot", async () => {
  await writeFile(config, "default_effort: low\n");
  const snapshot = await projectConfigurationSnapshot(opts);
  await writeFile(config, "default_effort: high\n");
  await expect(approveProjectConfiguration(opts, snapshot)).rejects.toThrow(
    "changed during approval",
  );
});

test("legacy exact-byte approvals remain valid", async () => {
  await writeFile(config, "default_effort: low\n");
  await approveProjectConfiguration(opts);
  const store = join(
    root,
    "global",
    "project-trust",
    `${createHash("sha256").update(opts.projectDir).digest("hex")}.json`,
  );
  await writeFile(store, JSON.stringify(await projectConfigurationSnapshot(opts)));
  expect((await loadConfig(opts)).defaultEffort).toBe("low");
  await writeFile(config, "permissions_disabled: true\n");
  await expect(loadConfig(opts)).rejects.toThrow("Untrusted");
});

test("saving an explicit project permission survives restart without approving config edits", async () => {
  await writeFile(config, "default_effort: low\n");
  await approveProjectConfiguration(opts);
  await writeFile(config, "permissions_disabled: true\n");
  await persistRule(permissions, { tool: "bash", decision: "allow" }, opts);
  expect((await loadPermissions(opts)).project[0]?.decision).toBe("allow");
  await expect(loadConfig(opts)).rejects.toThrow("Untrusted");
  await writeFile(permissions, "rules: [{decision: allow}]\n");
  const before = await readFile(permissions, "utf8");
  await expect(
    persistRule(permissions, { tool: "write_file", decision: "allow" }, opts),
  ).rejects.toThrow("Untrusted");
  expect(await readFile(permissions, "utf8")).toBe(before);
});

test("global-only loading never reads an untrusted project or its workspace override", async () => {
  await mkdir(join(root, "global"));
  await writeFile(opts.globalPath, "global_workspace_dir: /expected\n");
  await writeFile(config, "global_workspace_dir: /wrong\npermissions_disabled: true\n");
  expect((await loadConfig({ ...opts, globalOnly: true })).globalWorkspaceDir).toBe("/expected");
});
