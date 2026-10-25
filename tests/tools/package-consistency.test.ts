import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBuildCommand } from "../../src/agent/build-gate/detect";
import { detectQualityCommands } from "../../src/agent/build-gate/quality";
import { consistentPackageCommand, projectPackageManager } from "../../src/lib/package-manager";
import type { Sandbox } from "../../src/sandbox/types";
import { BashTool } from "../../src/tools/bash";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("npm fallback selection survives a fresh tool instance and drives commands and build gates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-pm-"));
  dirs.push(dir);
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      devEngines: { packageManager: { name: "npm" } },
      scripts: { build: "vite build", lint: "oxlint" },
    }),
  );
  await Bun.write(join(dir, "bun.lock"), "stale");
  expect(await projectPackageManager(dir)).toBe("npm");
  const commands: string[] = [];
  const sandbox: Sandbox = {
    async exec(command) {
      commands.push(command);
      return { stdout: "done", stderr: "", exitCode: 0, timedOut: false, cancelled: false };
    },
    async dispose() {},
    writeRoot: () => null,
  };
  for (const command of ["bun install", "bun add -d tailwindcss", "bun run build"]) {
    const result = await new BashTool(sandbox).run(
      { command },
      { projectDir: dir, abortSignal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("project's npm package manager");
  }
  expect(commands.map((c) => c.split("\n").at(-1))).toEqual([
    "npm install",
    "npm install -D tailwindcss",
    "npm run build",
  ]);
  expect((await detectBuildCommand(dir))?.argv).toEqual(["npm", "run", "build"]);
  expect(await detectQualityCommands(dir)).toEqual(["npm run lint"]);
});

test("explicit packageManager takes precedence and arbitrary Bun programs stay untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleetus-pm-"));
  dirs.push(dir);
  await Bun.write(
    join(dir, "package.json"),
    JSON.stringify({
      packageManager: "pnpm@10.0.0",
      devEngines: { packageManager: { name: "npm" } },
    }),
  );
  expect(await projectPackageManager(dir)).toBe("pnpm");
  expect(consistentPackageCommand("bun run dev", "pnpm")).toBe("pnpm run dev");
  expect(consistentPackageCommand("bun install 2>&1 | Select-Object -Last 20", "npm")).toBe(
    "npm install 2>&1 | Select-Object -Last 20",
  );
  for (const command of [
    "bun server.ts",
    "bun --version",
    "echo 'bun install'",
    "bun install; echo done",
    "bun run $script",
  ])
    expect(consistentPackageCommand(command, "npm")).toBe(command);
});
