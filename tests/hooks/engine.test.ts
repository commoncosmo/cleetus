import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../../src/events/log";
import { buildHookEngine } from "../../src/hooks/engine";
import type { HookEntry } from "../../src/hooks/types";
import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types";

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  ...over,
});
function scriptedSandbox(script: (cmd: string, opts: ExecOptions) => Promise<ExecResult>): Sandbox {
  return { exec: script, dispose: async () => {}, writeRoot: () => null };
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-hooks-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

const sig = () => new AbortController().signal;
const PRE = (tool: string) => ({
  sessionId: "s",
  tool,
  args: {},
  summary: `${tool}: x`,
  signal: sig(),
});
const POST = (tool: string, okResult = true) => ({
  ...PRE(tool),
  result: { ok: okResult, output: "out", error: okResult ? undefined : "boom" },
});

test("empty list → no engine", () => {
  expect(buildHookEngine([], { sandbox: scriptedSandbox(async () => ok()), log })).toBeUndefined();
});

test("hooks that don't match the tool → allow / no feedback", async () => {
  const entries: HookEntry[] = [{ event: "pre_tool_use", matcher: "bash", command: "x" }];
  const engine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async () => ok({ exitCode: 1 })),
    log,
  })!;
  expect(await engine.runPreToolUse(PRE("read_file"))).toEqual({ allow: true }); // matcher misses
});

test("pre: exit 0 allows; non-zero blocks with stdout reason", async () => {
  const entries: HookEntry[] = [{ event: "pre_tool_use", matcher: "bash", command: "guard" }];
  const allowEngine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async () => ok()),
    log,
  })!;
  expect(await allowEngine.runPreToolUse(PRE("bash"))).toEqual({ allow: true });

  const blockEngine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async () => ok({ exitCode: 1, stdout: "no rm -rf" })),
    log,
  })!;
  expect(await blockEngine.runPreToolUse(PRE("bash"))).toEqual({
    allow: false,
    reason: "no rm -rf",
  });
});

test("pre: error/timeout fails closed (blocks)", async () => {
  const entries: HookEntry[] = [{ event: "pre_tool_use", command: "x" }];
  const timeoutEngine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async () => ok({ timedOut: true, exitCode: null })),
    log,
  })!;
  const out = await timeoutEngine.runPreToolUse(PRE("bash"));
  expect(out.allow).toBe(false);
  expect(out.reason).toContain("timeout");
});

test("pre: first block short-circuits (later hooks not run)", async () => {
  let calls = 0;
  const entries: HookEntry[] = [
    { event: "pre_tool_use", command: "first" },
    { event: "pre_tool_use", command: "second" },
  ];
  const engine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async (cmd) => {
      calls++;
      return cmd === "first" ? ok({ exitCode: 1, stdout: "blocked" }) : ok();
    }),
    log,
  })!;
  expect((await engine.runPreToolUse(PRE("bash"))).allow).toBe(false);
  expect(calls).toBe(1); // second never ran
});

test("post: concatenates stdout feedback; broken hooks are skipped", async () => {
  const entries: HookEntry[] = [
    { event: "post_tool_use", command: "a" },
    { event: "post_tool_use", command: "b" },
  ];
  // "a" emits feedback; "b" throws → runHook reports errored:true → engine skips it (fail-soft).
  const engine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async (cmd) => {
      if (cmd === "b") throw new Error("boom");
      return ok({ stdout: "lint: 2 errors" });
    }),
    log,
  })!;
  expect(await engine.runPostToolUse(POST("write_file"))).toEqual({ feedback: "lint: 2 errors" });
});

test("logs a hook_run event per execution", async () => {
  const entries: HookEntry[] = [{ event: "pre_tool_use", command: "x" }];
  const engine = buildHookEngine(entries, { sandbox: scriptedSandbox(async () => ok()), log })!;
  await engine.runPreToolUse(PRE("bash"));
  expect(log.query("s").some((e) => e.type === "hook_run")).toBe(true);
});

test("pre: non-serializable args do not throw (degrade gracefully) and still allow on exit 0", async () => {
  const entries: HookEntry[] = [{ event: "pre_tool_use", command: "x" }];
  let received = "";
  const engine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async (_cmd, opts) => {
      received = opts.stdin ?? "";
      return ok();
    }),
    log,
  })!;
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const out = await engine.runPreToolUse({
    sessionId: "s",
    tool: "bash",
    args: circular,
    summary: "bash: x",
    signal: sig(),
  });
  expect(out).toEqual({ allow: true }); // did not throw
  expect(received).toContain("<unserializable>"); // args degraded, payload still valid JSON
  expect(() => JSON.parse(received)).not.toThrow();
});

test("pre: a chatty block reason is truncated", async () => {
  const entries: HookEntry[] = [{ event: "pre_tool_use", command: "x" }];
  const huge = "z".repeat(10000);
  const engine = buildHookEngine(entries, {
    sandbox: scriptedSandbox(async () => ok({ exitCode: 1, stdout: huge })),
    log,
  })!;
  const out = await engine.runPreToolUse(PRE("bash"));
  expect(out.allow).toBe(false);
  expect(out.reason!.length).toBeLessThan(2100); // capped (~2000 + suffix)
  expect(out.reason).toContain("truncated");
});
