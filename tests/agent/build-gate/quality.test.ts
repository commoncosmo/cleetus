import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectQualityCommands, makeVerifyQuality } from "../../../src/agent/build-gate/quality";
import { DEFAULT_BUILD_GATE } from "../../../src/config/build-gate";
import type { ExecOptions, ExecResult } from "../../../src/sandbox/types";

const dirs: string[] = [];

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-quality-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const live = () => new AbortController().signal;
const result = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  ...overrides,
});

function fakeSandbox(scripted: ExecResult[]) {
  const commands: string[] = [];
  const queue = [...scripted];
  return {
    commands,
    exec: async (command: string, _opts: ExecOptions): Promise<ExecResult> => {
      commands.push(command);
      return queue.shift() ?? result();
    },
  };
}

test("detects configured lint and typecheck scripts with Bun", async () => {
  const dir = tmp({
    "package.json": JSON.stringify({
      scripts: { test: "bun test", lint: "biome check .", typecheck: "tsc --noEmit" },
    }),
    "bun.lock": "",
  });

  expect(await detectQualityCommands(dir)).toEqual(["bun run lint", "bun run typecheck"]);
});

test("does not invent missing quality scripts", async () => {
  const dir = tmp({
    "package.json": JSON.stringify({ scripts: { test: "bun test", build: "vite build" } }),
    "bun.lock": "",
  });

  expect(await detectQualityCommands(dir)).toEqual([]);
});

test("reports deterministic lint failures even when typecheck passes", async () => {
  const dir = tmp({
    "package.json": JSON.stringify({ scripts: { lint: "lint", typecheck: "typecheck" } }),
    "bun.lock": "",
  });
  const sandbox = fakeSandbox([
    result({ exitCode: 1, stderr: "src/ui/theme.ts format error" }),
    result({ stdout: "clean" }),
  ]);
  const verify = makeVerifyQuality({ projectDir: dir, sandbox, config: DEFAULT_BUILD_GATE });

  expect(await verify!(live())).toEqual([
    {
      key: "bash:bun run lint",
      command: "bun run lint",
      ok: false,
      detail: "src/ui/theme.ts format error",
      scope: "full",
    },
    {
      key: "bash:bun run typecheck",
      command: "bun run typecheck",
      ok: true,
      detail: "clean",
      scope: "full",
    },
  ]);
  expect(sandbox.commands).toEqual(["bun run lint", "bun run typecheck"]);
});
