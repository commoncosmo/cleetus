import { expect, test } from "bun:test";
import { runHook } from "../../src/hooks/run";
import type { HookEntry } from "../../src/hooks/types";
import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types";
import { SandboxUnavailableError } from "../../src/sandbox/types";

function fakeSandbox(impl: (cmd: string, opts: ExecOptions) => Promise<ExecResult>): Sandbox {
  return { exec: impl, dispose: async () => {}, writeRoot: () => null };
}
const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  ...over,
});

test("passes command, timeout, signal, and stdin to the sandbox", async () => {
  let seen: { cmd: string; opts: ExecOptions } | null = null;
  const sb = fakeSandbox(async (cmd, opts) => {
    seen = { cmd, opts };
    return ok({ stdout: "fine" });
  });
  const entry: HookEntry = { event: "pre_tool_use", command: "guard.sh", timeoutMs: 1234 };
  const sig = new AbortController().signal;
  const r = await runHook(entry, '{"x":1}', sb, sig);
  expect(r).toEqual({ exitCode: 0, stdout: "fine", stderr: "", timedOut: false, errored: false });
  expect(seen!.cmd).toBe("guard.sh");
  expect(seen!.opts.timeoutMs).toBe(1234);
  expect(seen!.opts.stdin).toBe('{"x":1}');
  expect(seen!.opts.signal).toBe(sig);
});

test("defaults the timeout to 30000 when unset", async () => {
  let seenTimeout: number | undefined;
  const sb = fakeSandbox(async (_c, opts) => {
    seenTimeout = opts.timeoutMs;
    return ok();
  });
  await runHook({ event: "pre_tool_use", command: "x" }, "{}", sb, new AbortController().signal);
  expect(seenTimeout).toBe(30000);
});

test("a sandbox throw becomes errored:true (fail-closed signal)", async () => {
  const sb = fakeSandbox(async () => {
    throw new SandboxUnavailableError("no docker");
  });
  const r = await runHook(
    { event: "pre_tool_use", command: "x" },
    "{}",
    sb,
    new AbortController().signal,
  );
  expect(r.errored).toBe(true);
  expect(r.stderr).toContain("no docker");
});

test("surfaces timedOut", async () => {
  const sb = fakeSandbox(async () => ok({ timedOut: true, exitCode: null }));
  const r = await runHook(
    { event: "pre_tool_use", command: "x" },
    "{}",
    sb,
    new AbortController().signal,
  );
  expect(r.timedOut).toBe(true);
  expect(r.errored).toBe(false);
});
