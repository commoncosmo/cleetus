import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeVerifyBuild } from "../../../src/agent/build-gate/wire";
import { DEFAULT_BUILD_GATE } from "../../../src/config/build-gate";
import type { ExecOptions, ExecResult } from "../../../src/sandbox/types";

const dirs: string[] = [];
function tmp(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cleetus-wire-"));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const live = () => new AbortController().signal;
const noopFix = async () => {};
const result = (over: Partial<ExecResult>): ExecResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  ...over,
});

/** A fake sandbox that records commands and returns scripted ExecResults. */
function fakeSandbox(scripted: ExecResult[]) {
  const commands: string[] = [];
  const queue = [...scripted];
  return {
    commands,
    exec: async (command: string, _opts: ExecOptions): Promise<ExecResult> => {
      commands.push(command);
      return queue.shift() ?? result({});
    },
  };
}

test("enabled: false → undefined (orchestrator never calls it)", () => {
  const sandbox = fakeSandbox([]);
  expect(
    makeVerifyBuild({
      projectDir: ".",
      sandbox,
      config: { ...DEFAULT_BUILD_GATE, enabled: false },
    }),
  ).toBeUndefined();
});

test("enabled + build script + clean build → passed, runs `bun run build`", async () => {
  const d = tmp({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "bun.lock": "",
  });
  const sandbox = fakeSandbox([result({ exitCode: 0 })]);
  const verify = makeVerifyBuild({ projectDir: d, sandbox, config: DEFAULT_BUILD_GATE });
  expect(verify).toBeDefined();
  const res = await verify!(noopFix, live());
  expect(res).toEqual({ outcome: "passed", fixRounds: 0 });
  expect(sandbox.commands[0]).toBe("bun run build");
});

test("no build command at call time → null (skip)", async () => {
  const d = tmp({ "package.json": JSON.stringify({ scripts: {} }) });
  const sandbox = fakeSandbox([]);
  const verify = makeVerifyBuild({ projectDir: d, sandbox, config: DEFAULT_BUILD_GATE });
  expect(await verify!(noopFix, live())).toBeNull();
  expect(sandbox.commands).toHaveLength(0); // never ran a build
});

test("failed build then a fix makes it pass → fixed, fix sees the error tail", async () => {
  const d = tmp({
    "package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    "bun.lock": "",
  });
  const sandbox = fakeSandbox([
    result({ exitCode: 1, stderr: "TS2307: cannot find module '@/ui/button'" }),
    result({ exitCode: 0 }),
  ]);
  const fixTails: string[] = [];
  const verify = makeVerifyBuild({ projectDir: d, sandbox, config: DEFAULT_BUILD_GATE });
  const res = await verify!(async (tail) => {
    fixTails.push(tail);
  }, live());
  expect(res!.outcome).toBe("fixed");
  expect(res!.fixRounds).toBe(1);
  expect(fixTails[0]).toContain("@/ui/button");
});

test("persistent failure → failing, tail capped to max_output_lines", async () => {
  const d = tmp({ "package.json": JSON.stringify({ scripts: { build: "x" } }), "bun.lock": "" });
  const bigStderr = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const sandbox = fakeSandbox([
    result({ exitCode: 1, stderr: bigStderr }),
    result({ exitCode: 1, stderr: bigStderr }),
    result({ exitCode: 1, stderr: bigStderr }),
  ]);
  const verify = makeVerifyBuild({
    projectDir: d,
    sandbox,
    config: { ...DEFAULT_BUILD_GATE, maxOutputLines: 5 },
  });
  const res = await verify!(noopFix, live());
  expect(res!.outcome).toBe("failing");
  expect(res!.finalErrorTail!.split("\n")).toHaveLength(5); // capped
  expect(res!.finalErrorTail).toContain("line 49"); // keeps the tail
});
