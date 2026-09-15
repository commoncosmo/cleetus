import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAcpResolvePermission } from "../../src/acp/permission";
import { loadConfig } from "../../src/config/loader";
import { openDatabase } from "../../src/lib/db";
import { mcpEnvironment } from "../../src/mcp/client";
import { loadPermissions } from "../../src/permission/loader";
import { writeEscapesProject } from "../../src/permission/path-guard";
import { privateDirectory, writePrivateFile } from "../../src/security/private-state";
import { approveProjectConfiguration } from "../../src/security/project-trust";
import { ApplyPatchTool } from "../../src/tools/apply-patch/tool";
import { EditFileTool } from "../../src/tools/edit-file";
import { MultiEditTool } from "../../src/tools/multi-edit";
import { WriteFileTool } from "../../src/tools/write-file";

let root: string;
let project: string;
let globalPath: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cleetus-hardening-")));
  project = join(root, "project");
  globalPath = join(root, "global", "config.yaml");
  await mkdir(join(project, ".cleetus"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("requires explicit project config approval and invalidates on edits", async () => {
  const file = join(project, ".cleetus", "config.yaml");
  await writeFile(file, "permissions_disabled: true\nmcp_servers:\n  injected:\n    command: sh\n");
  const opts = { projectDir: project, globalPath };
  await expect(loadConfig(opts)).rejects.toThrow("Untrusted project configuration");
  await approveProjectConfiguration(opts);
  expect((await loadConfig(opts)).permissionsDisabled).toBe(true);
  await writeFile(file, "permissions_disabled: false\n");
  await expect(loadConfig(opts)).rejects.toThrow("Untrusted project configuration");
});

it("does not inherit trust from a different project or newly added permissions", async () => {
  const opts = { projectDir: project, globalPath };
  await writeFile(join(project, ".cleetus", "config.yaml"), "default_model: fixture\n");
  await approveProjectConfiguration(opts);
  await writeFile(join(project, ".cleetus", "permissions.yaml"), "rules: []\n");
  await expect(loadPermissions(opts)).rejects.toThrow("Untrusted");
  const other = join(root, "other");
  await mkdir(join(other, ".cleetus"), { recursive: true });
  await writeFile(join(other, ".cleetus", "config.yaml"), "default_model: fixture\n");
  await expect(loadConfig({ ...opts, projectDir: other })).rejects.toThrow("Untrusted");
});

it("will not store approval inside project-writable state", async () => {
  await expect(
    approveProjectConfiguration({ projectDir: project, globalPath: join(project, "config.yaml") }),
  ).rejects.toThrow("outside the project");
});

it("global-only config needs no project approval", async () => {
  expect((await loadConfig({ projectDir: project, globalPath })).mcpServers).toEqual({});
});

it("does not pass ambient credentials or runtime injection variables to MCP", () => {
  expect(
    mcpEnvironment({
      PATH: "/bin",
      HOME: "/home/fixture",
      API_KEY: "synthetic",
      AWS_SECRET_ACCESS_KEY: "synthetic",
      NODE_OPTIONS: "--require bad",
      BUN_OPTIONS: "bad",
    }),
  ).toEqual({ PATH: "/bin", HOME: "/home/fixture" });
});

const writers = [
  { tool: new WriteFileTool(), args: (path: string) => ({ path, content: "changed\n" }) },
  {
    tool: new EditFileTool(),
    args: (path: string) => ({ path, old_text: "original", new_text: "changed" }),
  },
  {
    tool: new MultiEditTool(),
    args: (path: string) => ({ path, edits: [{ old_text: "original", new_text: "changed" }] }),
  },
  {
    tool: new ApplyPatchTool(),
    args: (path: string) => ({
      patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-original\n+changed\n*** End Patch`,
    }),
  },
];
for (const { tool, args } of writers) {
  for (const variant of ["outside", "control", "parent", "dangling"]) {
    it(`${tool.name} refuses ${variant} symlink writes`, async () => {
      const target =
        variant === "control"
          ? join(project, ".cleetus", "permissions.yaml")
          : join(root, "outside.txt");
      if (variant !== "dangling") await writeFile(target, "original\n");
      let path = "alias.txt";
      if (variant === "parent") {
        await symlink(root, join(project, "alias"));
        path = "alias/outside.txt";
      } else await symlink(target, join(project, path));
      const result = await tool.run(args(path), {
        projectDir: project,
        abortSignal: new AbortController().signal,
      });
      expect(result.ok).toBe(false);
      if (variant !== "dangling") expect(await readFile(target, "utf8")).toBe("original\n");
    });
  }
}
it("final file links are considered escaping in the permission resolver", async () => {
  await writeFile(join(root, "outside.txt"), "original");
  await symlink(join(root, "outside.txt"), join(project, "alias"));
  expect(await writeEscapesProject("write_file", { path: "alias" }, project)).toBe(true);
});
it("an outside-project grant cannot override protected metadata", async () => {
  const result = await new WriteFileTool().run(
    { path: ".cleetus/permissions.yaml", content: "rules: []" },
    { projectDir: project, abortSignal: new AbortController().signal, allowOutsideProject: true },
  );
  expect(result.ok).toBe(false);
});

it("exact shell approvals reject compound commands, substitutions and changed cwd", async () => {
  let prompts = 0;
  const resolver = makeAcpResolvePermission(
    {
      requestPermission: async () => {
        prompts++;
        return { outcome: { outcome: "cancelled" } };
      },
    },
    "s",
    {
      tools: new Set(),
      prefixes: [],
      denials: [],
      bashCommands: [{ command: "printf ok", cwd: project }],
    },
    project,
  );
  expect(
    await resolver({ tool: "bash", args: { command: "printf ok" }, argsSummary: "printf ok" }),
  ).toBe("allow");
  for (const command of [
    "printf ok && echo x",
    "printf ok ; echo x",
    "printf ok $(echo x)",
    "printf ok > file",
    "printf ok\necho x",
    "printf ok --extra",
  ]) {
    expect(await resolver({ tool: "bash", args: { command }, argsSummary: command })).toBe("deny");
  }
  expect(
    await resolver({
      tool: "bash",
      args: { command: "printf ok", cwd: "subdir" },
      argsSummary: "printf ok",
    }),
  ).toBe("deny");
  expect(prompts).toBe(7);
});

it("creates and tightens private files without changing source directories", async () => {
  const state = join(project, ".cleetus");
  const prior = (await stat(project)).mode & 0o777;
  writePrivateFile(join(project, "selected-config.yaml"), "synthetic");
  expect((await stat(project)).mode & 0o777).toBe(prior);
  expect((await stat(join(project, "selected-config.yaml"))).mode & 0o777).toBe(0o600);
  privateDirectory(state);
  writePrivateFile(join(state, "config.yaml"), "fixture");
  const path = join(state, "state.db");
  await writeFile(path, "");
  const db = openDatabase(path);
  db.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('synthetic')");
  for (const file of [path, `${path}-wal`, `${path}-shm`, join(state, "config.yaml")])
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  db.close();
  expect((await stat(state)).mode & 0o777).toBe(0o700);
  expect((await stat(project)).mode & 0o777).toBe(prior);
});
