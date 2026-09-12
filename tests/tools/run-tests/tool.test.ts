import { describe, expect, test } from "bun:test";
import type { ExecOptions, ExecResult, Sandbox } from "../../../src/sandbox/types";
import { SandboxUnavailableError } from "../../../src/sandbox/types";
import { buildTestRunner } from "../../../src/tools/run-tests/index";
import { RunTestsTool } from "../../../src/tools/run-tests/tool";

function fakeSandbox(result: Partial<ExecResult> | (() => never)): {
  sandbox: Sandbox;
  calls: { command: string; opts: ExecOptions }[];
} {
  const calls: { command: string; opts: ExecOptions }[] = [];
  const sandbox: Sandbox = {
    async exec(command, opts) {
      calls.push({ command, opts });
      if (typeof result === "function") result();
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        ...(result as Partial<ExecResult>),
      };
    },
    async dispose() {},
    writeRoot: () => null,
  };
  return { sandbox, calls };
}

const CFG = { timeoutMs: 60_000, maxOutputLines: 50 };
const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };

const bunResolver = () =>
  Promise.resolve({ runner: { runnerId: "bun", argv: ["bun", "test"] }, warnings: [] });
const noneResolver =
  (warnings: string[] = []) =>
  () =>
    Promise.resolve({ runner: null, warnings });

describe("RunTestsTool", () => {
  test("metadata + serialize is generic until resolved, then shows the command", async () => {
    const { sandbox } = fakeSandbox({});
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    expect(tool.name).toBe("run_tests");
    expect(tool.mutates).toBe(true);
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        check: {
          type: "string",
          enum: ["test", "build", "typecheck", "lint"],
          description: "Project check to run; defaults to test.",
        },
        filter: {
          type: "string",
          description:
            "Optional test-name pattern: run only matching tests (fast red→green loop). Some runners (npm script, configured command) ignore it and run the full suite.",
        },
      },
      additionalProperties: false,
    });
    expect(tool.serialize()).toBe("run_tests (auto-detect)");
    await tool.run({}, ctx);
    expect(tool.serialize()).toBe("bun test"); // cached after first run
  });

  test("runs the resolved command and reports pass", async () => {
    const { sandbox, calls } = fakeSandbox({ exitCode: 0 });
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    const res = await tool.run({}, ctx);
    expect(res.ok).toBe(true);
    expect(calls[0]!.command).toBe("bun test");
  });

  test("pass → ok:true with the passed headline; runs the argv joined, in projectDir", async () => {
    const { sandbox, calls } = fakeSandbox({ exitCode: 0, stdout: "ran 3 tests" });
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    const r = await tool.run({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("✓ tests passed");
    expect(calls[0]?.command).toBe("bun test");
    expect(calls[0]?.opts.cwd).toBe("/proj");
    expect(calls[0]?.opts.timeoutMs).toBe(60_000);
    expect(calls[0]?.opts.signal).toBe(ctx.abortSignal);
  });

  test("fail → ok:false with the failure text on errorMessage", async () => {
    const { sandbox } = fakeSandbox({ exitCode: 1, stdout: "FAIL: foo" });
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    const r = await tool.run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOOL_FAILED");
    expect(r.errorMessage).toBe("✗ tests failed (exit 1)\nFAIL: foo");
  });

  test("timeout → ok:false with the timeout header", async () => {
    const { sandbox } = fakeSandbox({ exitCode: null, timedOut: true, stdout: "stuck" });
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    const r = await tool.run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("✗ tests timed out after 60000ms\nstuck");
  });

  test("summaryRegex flows through to a passing summary line", async () => {
    const { sandbox } = fakeSandbox({ exitCode: 0, stdout: "noise\n=== 9 passed in 0.5s ===" });
    const tool = new RunTestsTool(
      sandbox,
      () =>
        Promise.resolve({
          runner: {
            runnerId: "pytest",
            argv: ["pytest"],
            summaryRegex: /^=+ .*(?:passed|failed|error).* =+$/m,
          },
          warnings: [],
        }),
      CFG,
    );
    const r = await tool.run({}, ctx);
    expect(r.output).toBe("✓ tests passed\n=== 9 passed in 0.5s ===");
  });

  test("sandbox-unavailable → ok:false with the error message, never throws", async () => {
    const { sandbox } = fakeSandbox(() => {
      throw new SandboxUnavailableError("container down");
    });
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    const r = await tool.run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("container down");
  });

  test("cancelled → ok:false with a clear cancelled message", async () => {
    const { sandbox } = fakeSandbox({ exitCode: null, cancelled: true, stdout: "partial" });
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    const r = await tool.run({}, ctx);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOOL_FAILED");
    expect(r.errorMessage).toBe("✗ tests cancelled");
  });

  test("no runner → actionable error carrying detection warnings, no exec", async () => {
    const { sandbox, calls } = fakeSandbox({ exitCode: 0 });
    const tool = new RunTestsTool(
      sandbox,
      noneResolver(["rust tests unavailable: 'cargo' not found"]),
      CFG,
    );
    const res = await tool.run({}, ctx);
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain("no test runner detected");
    expect(res.errorMessage).toContain("cargo");
    expect(calls.length).toBe(0);
  });

  test("re-detects while unresolved (scaffold-mid-session)", async () => {
    const { sandbox } = fakeSandbox({ exitCode: 0 });
    let runner: { runnerId: string; argv: string[] } | null = null;
    const tool = new RunTestsTool(sandbox, () => Promise.resolve({ runner, warnings: [] }), CFG);
    expect((await tool.run({}, ctx)).ok).toBe(false); // no runner yet
    runner = { runnerId: "bun", argv: ["bun", "test"] }; // harness scaffolded
    expect((await tool.run({}, ctx)).ok).toBe(true); // now resolves
  });

  test("re-resolves runners in the active project after scaffolding or manifest edits", async () => {
    const { sandbox, calls } = fakeSandbox({ exitCode: 0 });
    const resolutions: string[] = [];
    const tool = new RunTestsTool(
      sandbox,
      async (projectDir) => {
        resolutions.push(projectDir ?? "");
        return {
          runner: {
            runnerId: "configured",
            argv: ["test-project", projectDir ?? ""],
          },
          warnings: [],
        };
      },
      CFG,
    );

    await tool.run({}, { ...ctx, projectDir: "/one" });
    await tool.run({}, { ...ctx, projectDir: "/two" });
    await tool.run({}, { ...ctx, projectDir: "/one" });

    expect(resolutions).toEqual(["/one", "/two", "/one"]);
    expect(calls.map((call) => call.command)).toEqual([
      "test-project /one",
      "test-project /two",
      "test-project /one",
    ]);
  });

  test("filter on a bun runner narrows the executed command", async () => {
    const { sandbox, calls } = fakeSandbox({ exitCode: 0 });
    const tool = new RunTestsTool(sandbox, bunResolver, CFG);
    await tool.run({ filter: "slug" }, ctx);
    expect(calls[0]!.command).toBe("bun test -t 'slug'");
  });

  test("filter on a node runner runs the full suite and notes the fallback", async () => {
    const { sandbox, calls } = fakeSandbox({ exitCode: 0 });
    const nodeResolver = () =>
      Promise.resolve({ runner: { runnerId: "node", argv: ["npm", "test"] }, warnings: [] });
    const tool = new RunTestsTool(sandbox, nodeResolver, CFG);
    const res = await tool.run({ filter: "slug" }, ctx);
    expect(calls[0]!.command).toBe("npm test");
    expect(res.ok).toBe(true);
    expect((res as { output: string }).output).toContain("filter not supported for node");
  });
});

describe("buildTestRunner", () => {
  test("disabled → not registered, resolver yields no runner", async () => {
    const built = await buildTestRunner(
      { enabled: false, command: undefined, timeoutMs: 1, maxOutputLines: 1 },
      "/proj",
    );
    expect(built.register).toBe(false);
    expect(await built.resolve()).toEqual({ runner: null, warnings: [] });
  });

  test("config.command → registered, resolver yields a runner with that argv", async () => {
    const built = await buildTestRunner(
      { enabled: true, command: "make test", timeoutMs: 1, maxOutputLines: 1 },
      "/proj",
    );
    expect(built.register).toBe(true);
    expect((await built.resolve()).runner?.argv).toEqual(["make", "test"]);
  });

  test("config.command as a string[] is used verbatim", async () => {
    const built = await buildTestRunner(
      { enabled: true, command: ["bun", "test", "--bail"], timeoutMs: 1, maxOutputLines: 1 },
      "/proj",
    );
    expect((await built.resolve()).runner?.argv).toEqual(["bun", "test", "--bail"]);
  });

  test("ACP-style registration can defer stack detection to each active project", async () => {
    const built = await buildTestRunner(
      { enabled: true, command: undefined, timeoutMs: 1, maxOutputLines: 1 },
      "/project-without-markers",
      { registerForAnyProject: true },
    );
    expect(built.register).toBe(true);
  });
});

test("structured build check preserves failing exit status and does not accept a test filter", async () => {
  const { sandbox, calls } = fakeSandbox({ exitCode: 2, stderr: "Type error: missing model" });
  const requested: string[] = [];
  const tool = new RunTestsTool(
    sandbox,
    async (_dir, check) => {
      requested.push(check ?? "test");
      return { runner: { runnerId: "script", argv: ["bun", "run", "build"] }, warnings: [] };
    },
    CFG,
  );
  const result = await tool.run({ check: "build" }, ctx);
  expect(requested).toEqual(["build"]);
  expect(calls[0]!.command).toBe("bun run build");
  expect(result.ok).toBe(false);
  expect(result.verification).toEqual({
    command: "bun run build",
    exitCode: 2,
    timedOut: false,
    check: "build",
  });
  expect(result.errorMessage).toContain("missing model");
  await tool.run({ check: "build", filter: "ignored" }, ctx);
  expect(calls.length).toBe(1);
});
