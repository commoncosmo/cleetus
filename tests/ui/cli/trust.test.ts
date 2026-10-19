import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader";
import {
  approveProjectConfiguration,
  projectTrustCommand,
} from "../../../src/security/project-trust";

const cli = new URL("../../../src/bin/cleetus.ts", import.meta.url).pathname;
let root: string;
let cwd: string;
let workspace: string;
let configDir: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cleetus-trust-cli-")));
  cwd = join(root, "launch");
  workspace = join(root, "global workspace's files");
  configDir = join(root, "config");
  for (const dir of [cwd, workspace]) await mkdir(join(dir, ".cleetus"), { recursive: true });
  await mkdir(configDir);
  await writeFile(
    join(configDir, "config.yaml"),
    `global_workspace_dir: ${JSON.stringify(workspace)}\n`,
  );
  await writeFile(join(cwd, ".cleetus", "config.yaml"), "permissions_disabled: true\n");
  await writeFile(join(workspace, ".cleetus", "config.yaml"), "default_effort: low\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function invoke(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env: { ...process.env, HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

test("trust --global previews and approves the configured workspace from an untrusted cwd", async () => {
  const opts = { projectDir: workspace, globalPath: join(configDir, "config.yaml") };
  const preview = await invoke(["trust", "--global", "--config-dir", "../config"]);
  expect(preview.code).toBe(0);
  expect(preview.out).toContain(`Workspace: ${workspace}`);
  expect(preview.out).toContain(`cleetus trust --global --config-dir ${configDir} --yes`);
  await expect(loadConfig(opts)).rejects.toThrow("Untrusted");
  expect((await invoke(["trust", "--global", "--config-dir", "../config", "--yes"])).code).toBe(0);
  expect((await loadConfig(opts)).defaultEffort).toBe("low");
  await expect(loadConfig({ ...opts, projectDir: cwd })).rejects.toThrow("Untrusted");
});

test("trust --global defaults to ~/.cleetus and preserves cwd", async () => {
  const defaultWorkspace = join(root, ".cleetus");
  await mkdir(join(defaultWorkspace, ".cleetus"), { recursive: true });
  await writeFile(join(defaultWorkspace, ".cleetus", "config.yaml"), "default_effort: high\n");
  await writeFile(join(configDir, "config.yaml"), "{}\n");
  const result = await invoke(["trust", "--global", "--config-dir", "../config", "--yes"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`Workspace: ${defaultWorkspace}`);
  expect(
    (await loadConfig({ projectDir: defaultWorkspace, globalPath: join(configDir, "config.yaml") }))
      .defaultEffort,
  ).toBe("high");
});

test("trust --directory supports relative paths; conflicting targets are rejected", async () => {
  const result = await invoke([
    "trust",
    "--directory",
    "../global workspace's files",
    "--config-dir",
    "../config",
    "--yes",
  ]);
  expect(result.code).toBe(0);
  expect(
    (await loadConfig({ projectDir: workspace, globalPath: join(configDir, "config.yaml") }))
      .defaultEffort,
  ).toBe("low");
  const conflict = await invoke(["trust", "--global", "--directory", workspace, "--yes"]);
  expect(conflict.code).not.toBe(0);
  expect(conflict.err).toContain("choose either");
});

test("the recovery command works from another cwd with spaces and apostrophes", async () => {
  const opts = { projectDir: workspace, globalPath: join(configDir, "config.yaml") };
  const command = projectTrustCommand(opts).replace(/^cleetus /, `${process.execPath} ${cli} `);
  const child = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  expect((await loadConfig(opts)).defaultEffort).toBe("low");
});

for (const scope of ["--global", "--scratch"]) {
  test(`ACP ${scope} skips launch-cwd trust but checks its actual workspace`, async () => {
    if (scope === "--global") {
      const denied = await invoke(["acp", scope, "--config-dir", "../config"]);
      expect(denied.err).toContain(join(workspace, ".cleetus", "config.yaml"));
      expect(denied.err).toContain(`\n  cleetus trust --global --config-dir ${configDir} --yes\n`);
      expect(denied.err).not.toContain("--directory");
      await approveProjectConfiguration({
        projectDir: workspace,
        globalPath: join(configDir, "config.yaml"),
      });
    }
    const result = await invoke(["acp", scope, "--config-dir", "../config"]);
    expect(result.err).toContain("no providers configured");
    expect(result.err).not.toContain("Untrusted");
  });

  test(`terminal ${scope} skips launch-cwd trust`, async () => {
    if (scope === "--global")
      await approveProjectConfiguration({
        projectDir: workspace,
        globalPath: join(configDir, "config.yaml"),
      });
    // A nonresponsive fixture provider avoids first-run setup; listing models remains offline.
    await writeFile(
      join(configDir, "config.yaml"),
      `global_workspace_dir: ${JSON.stringify(workspace)}\nproviders:\n  fixture:\n    type: lmstudio\n    base_url: http://127.0.0.1:1\n`,
    );
    const result = await invoke([scope, "--list-models", "--json", "--config-dir", "../config"]);
    expect(result.code).toBe(0);
    expect(result.err).not.toContain("Untrusted");
  });
}

for (const entry of [[], ["acp"]]) {
  test(`${entry.length ? "ACP" : "terminal"} global trust error uses the short command with default config`, async () => {
    const defaultConfigDir = join(root, ".config", "cleetus");
    await mkdir(defaultConfigDir, { recursive: true });
    await writeFile(
      join(defaultConfigDir, "config.yaml"),
      `global_workspace_dir: ${JSON.stringify(workspace)}\n`,
    );
    const result = await invoke([...entry, "--global"]);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("\n  cleetus trust --global --yes\n");
    expect(result.err).not.toContain("--config-dir");
    expect(result.err).not.toContain("--directory");
  });
}

test("terminal global permission errors also use the short command", async () => {
  const defaultConfigDir = join(root, ".config", "cleetus");
  await mkdir(defaultConfigDir, { recursive: true });
  await writeFile(
    join(defaultConfigDir, "config.yaml"),
    `global_workspace_dir: ${JSON.stringify(workspace)}\nproviders:\n  fixture:\n    type: lmstudio\n    base_url: http://127.0.0.1:1\n`,
  );
  await rm(join(workspace, ".cleetus", "config.yaml"));
  await writeFile(join(workspace, ".cleetus", "permissions.yaml"), "rules: []\n");
  const result = await invoke(["--global"]);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain(join(workspace, ".cleetus", "permissions.yaml"));
  expect(result.err).toContain("\n  cleetus trust --global --yes\n");
});
