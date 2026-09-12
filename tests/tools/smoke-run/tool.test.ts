import { expect, test } from "bun:test";
import { DEFAULT_SMOKE_RUN } from "../../../src/config/smoke-run";
import type { ExecOptions, ExecResult, Sandbox } from "../../../src/sandbox/types";
import { SandboxUnavailableError } from "../../../src/sandbox/types";
import {
  SmokeRunTool,
  backgroundsSmokeCommand,
  clampSeconds,
} from "../../../src/tools/smoke-run/tool";

function fakeSandbox(
  result: Partial<ExecResult>,
  capture?: (cmd: string, opts: ExecOptions) => void,
): Sandbox {
  return {
    async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
      capture?.(command, opts);
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, cancelled: false, ...result };
    },
    async dispose() {},
  } as Sandbox;
}

const ctx = () => ({
  projectDir: "/proj",
  abortSignal: new AbortController().signal,
  allowOutsideProject: false,
});

test("clampSeconds: default when omitted, clamp to max, floor at 1", () => {
  expect(clampSeconds(undefined, DEFAULT_SMOKE_RUN)).toBe(10);
  expect(clampSeconds(999, DEFAULT_SMOKE_RUN)).toBe(30);
  expect(clampSeconds(0, DEFAULT_SMOKE_RUN)).toBe(1);
  expect(clampSeconds(5, DEFAULT_SMOKE_RUN)).toBe(5);
});

test("background commands are rejected because smoke_run owns teardown", async () => {
  expect(backgroundsSmokeCommand("bun run dev &")).toBe(true);
  expect(backgroundsSmokeCommand("bun run dev && curl localhost:3000")).toBe(false);
  expect(backgroundsSmokeCommand("bun run dev 2>&1")).toBe(false);
  let executed = false;
  const tool = new SmokeRunTool(
    fakeSandbox({}, () => {
      executed = true;
    }),
    DEFAULT_SMOKE_RUN,
  );
  const result = await tool.run({ command: "bun run dev &" }, ctx() as never);
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toContain("without '&'");
  expect(executed).toBe(false);
});

test("clean exit → ok:true with ✓ verdict", async () => {
  const tool = new SmokeRunTool(fakeSandbox({ exitCode: 0, stdout: "built" }), DEFAULT_SMOKE_RUN);
  const r = await tool.run({ command: "bun run build" }, ctx() as never);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("✓ exited cleanly");
});

test("non-zero exit is ok:true (a probe, not a gate) with ✗ verdict", async () => {
  const tool = new SmokeRunTool(fakeSandbox({ exitCode: 1, stderr: "nope" }), DEFAULT_SMOKE_RUN);
  const r = await tool.run({ command: "x" }, ctx() as never);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("✗ exited with code 1");
});

test("still running (timed out) → ok:true with ⏱ verdict", async () => {
  const tool = new SmokeRunTool(
    fakeSandbox({ timedOut: true, exitCode: null, stdout: "waiting…" }),
    DEFAULT_SMOKE_RUN,
  );
  const r = await tool.run({ command: "bun run tauri dev" }, ctx() as never);
  expect(r.ok).toBe(true);
  expect(r.output).toContain("⏱ still running");
});

test("cancelled → ok:false", async () => {
  const tool = new SmokeRunTool(fakeSandbox({ cancelled: true }), DEFAULT_SMOKE_RUN);
  const r = await tool.run({ command: "x" }, ctx() as never);
  expect(r.ok).toBe(false);
});

test("sandbox unavailable → ok:false with the reason", async () => {
  const sandbox = {
    async exec() {
      throw new SandboxUnavailableError("no docker");
    },
    async dispose() {},
  } as unknown as Sandbox;
  const tool = new SmokeRunTool(sandbox, DEFAULT_SMOKE_RUN);
  const r = await tool.run({ command: "x" }, ctx() as never);
  expect(r.ok).toBe(false);
  expect(r.errorMessage).toContain("no docker");
});

test("forwards cwd, signal, and the clamped timeout to exec", async () => {
  let seenCmd = "";
  let seenOpts: ExecOptions | undefined;
  const tool = new SmokeRunTool(
    fakeSandbox({ exitCode: 0 }, (cmd, opts) => {
      seenCmd = cmd;
      seenOpts = opts;
    }),
    DEFAULT_SMOKE_RUN,
  );
  await tool.run({ command: "echo hi", seconds: 3 }, ctx() as never);
  expect(seenCmd).toBe("echo hi");
  expect(seenOpts?.cwd).toBe("/proj");
  expect(seenOpts?.timeoutMs).toBe(3000);
  expect(seenOpts?.signal).toBeDefined();
});

test("serialize returns the command for the permission prompt", () => {
  const tool = new SmokeRunTool(fakeSandbox({}), DEFAULT_SMOKE_RUN);
  expect(tool.serialize({ command: "bun run dev" })).toBe("bun run dev");
});
