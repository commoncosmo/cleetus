import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Router } from "../../src/agent/router";
import { staticRouter } from "../../src/agent/router";
import {
  AgentRuntime,
  compactVerificationForModel,
  completionAuditToolBlock,
  incrementalProgressTokens,
  smokeInfrastructureInstallBlock,
  verificationClosesSourceLease,
  verificationCommandKey,
  verificationCommandMasksExit,
  verificationEvidence,
  verificationFailureIds,
  verificationSucceeded,
} from "../../src/agent/runtime";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { DEFAULT_LOOP_GUARD } from "../../src/config/loop-guard";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

/** Emits a tool call every turn (never finishes on its own) and reports fixed usage per call,
 *  so cumulative spend climbs by `perCall` each round-trip. */
class UsageProvider implements Provider {
  calls = 0;
  constructor(private readonly perCall: number) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    yield { type: "text-delta", text: "working" };
    yield {
      type: "tool-call",
      call: { id: `c${this.calls}`, name: "bash", args: { command: "ls" } },
    };
    yield {
      type: "finish",
      reason: "tool-calls",
      usage: { input: this.perCall, output: 0 },
      model: "m",
    };
  }
  async embed() {
    return [0];
  }
}

/** Same endless bash loop, but its reported full input context grows by `growth` each call. */
class GrowingUsageProvider implements Provider {
  calls = 0;
  constructor(private readonly growth: number) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    yield {
      type: "tool-call",
      call: { id: `c${this.calls}`, name: "bash", args: { command: "ls" } },
    };
    yield {
      type: "finish",
      reason: "tool-calls",
      usage: { input: this.calls * this.growth, output: 0 },
      model: "m",
    };
  }
  async embed() {
    return [0];
  }
}

/** Reproduces the empty-completion retry path: the FIRST call returns an empty turn (no text, no
 *  tool call, finish "stop") but is already billed real usage; the retry returns a tool call; a
 *  later call returns a final answer. Proves the billed-but-empty first call's usage is counted. */
class EmptyThenToolProvider implements Provider {
  calls = 0;
  constructor(private readonly perCall: number) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      // Empty completion — no text, no tool call — but with real (billed) usage. Triggers retry.
      yield {
        type: "finish",
        reason: "stop",
        usage: { input: this.perCall, output: 0 },
        model: "m",
      };
      return;
    }
    if (this.calls === 2) {
      // The retry produces a tool call, also billed.
      yield {
        type: "tool-call",
        call: { id: "c-retry", name: "bash", args: { command: "ls" } },
      };
      yield {
        type: "finish",
        reason: "tool-calls",
        usage: { input: this.perCall, output: 0 },
        model: "m",
      };
      return;
    }
    // Any later call: a clean final answer, so the turn would complete normally if it got here.
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop", usage: { input: 0, output: 0 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

/** Emits one landed-diff `write_file` call first, then plain `bash` calls (never landing a diff
 *  again) thereafter — used to prove `tokensSinceLastEdit` resets on the landed edit and does not
 *  keep accruing from before it. */
class EditThenBashProvider implements Provider {
  calls = 0;
  constructor(private readonly perCall: number) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield { type: "text-delta", text: "editing" };
      yield {
        type: "tool-call",
        call: { id: "c1", name: "write_file", args: { path: "out.txt", content: "x" } },
      };
    } else {
      yield { type: "text-delta", text: "working" };
      yield {
        type: "tool-call",
        call: { id: `c${this.calls}`, name: "bash", args: { command: "ls" } },
      };
    }
    yield {
      type: "finish",
      reason: "tool-calls",
      usage: { input: this.perCall, output: 0 },
      model: "m",
    };
  }
  async embed() {
    return [0];
  }
}

/** Always requests the same failing command; never finishes on its own. */
class RepeatFailProvider implements Provider {
  calls = 0;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    yield { type: "text-delta", text: "retrying" };
    yield {
      type: "tool-call",
      call: { id: `c${this.calls}`, name: "bash", args: { command: "bun run build" } },
    };
    yield { type: "finish", reason: "tool-calls", usage: { input: 10, output: 0 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

/** Runs one explicit failing verification command, then finishes normally in prose. */
class FailedVerificationThenFinishProvider implements Provider {
  calls = 0;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: "tool-call",
        call: { id: "verify", name: "bash", args: { command: "bun test" } },
      };
      yield { type: "finish", reason: "tool-calls", usage: { input: 100, output: 10 }, model: "m" };
      return;
    }
    yield { type: "text-delta", text: "Those failures are unrelated; done." };
    yield { type: "finish", reason: "stop", usage: { input: 200, output: 10 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

class RepeatedVerificationProvider implements Provider {
  calls = 0;
  constructor(private readonly editBetween = false) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1 || (this.editBetween ? this.calls === 3 : this.calls === 2)) {
      yield {
        type: "tool-call",
        call: { id: `verify-${this.calls}`, name: "bash", args: { command: "bun test" } },
      };
      yield { type: "finish", reason: "tool-calls", usage: { input: 100, output: 10 }, model: "m" };
      return;
    }
    if (this.editBetween && this.calls === 2) {
      yield {
        type: "tool-call",
        call: {
          id: "edit",
          name: "write_file",
          args: { path: "changed.ts", content: "export {};" },
        },
      };
      yield { type: "finish", reason: "tool-calls", usage: { input: 100, output: 10 }, model: "m" };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop", usage: { input: 100, output: 10 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

/** Bash stub that always fails — drives the loop-guard 'fail' rule. */
const failingBash: Tool = {
  name: "bash",
  description: "",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  mutates: true,
  serialize: () => "bash",
  run: async (): Promise<ToolResult> => ({ ok: false, errorMessage: "tsc error" }),
};

const stubBash: Tool = {
  name: "bash",
  description: "",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  mutates: true,
  serialize: () => "bash",
  run: async (): Promise<ToolResult> => ({ ok: true, output: "ok" }),
};

/** Stub write_file that always lands a diff — used to drive the no-progress-reset test. */
function makeWriteFileStub(dir: string): Tool {
  return {
    name: "write_file",
    description: "",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path"],
    },
    mutates: true,
    serialize: () => "write_file",
    run: async (args): Promise<ToolResult> => {
      const path = (args as { path: string }).path;
      return { ok: true, diff: { path: join(dir, path), before: "", after: "x", created: true } };
    },
  };
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-budget-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  workerTurnTokens: number,
  opts: {
    workerNoProgressTokens?: number;
    workerProgressExtensionTokens?: number;
    workerMaxTokenMultiplier?: number;
    extraTools?: Tool[];
  } = {},
) {
  const providers = new ProviderRegistry();
  providers.register("p", provider);
  const tools = new ToolRegistry();
  tools.register(stubBash);
  for (const t of opts.extraTools ?? []) tools.register(t);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 100,
    workerTurnTokens,
    workerProgressExtensionTokens: opts.workerProgressExtensionTokens,
    workerMaxTokenMultiplier: opts.workerMaxTokenMultiplier,
    workerNoProgressTokens: opts.workerNoProgressTokens,
  });
}

test("worker turn stops with token_budget after spend crosses the cap; no summary call", async () => {
  const provider = new UsageProvider(50000); // 50k input per call
  const runtime = makeRuntime(provider, 120000); // trips after the 3rd call (150k >= 120k)
  const r = await runtime.runTurn(
    "s1",
    "do it",
    new AbortController().signal,
    "orchestration-worker",
    "t1",
  );
  expect(r.stoppedReason).toBe("token_budget");
  expect(r.assistantText).toContain("~150k billed-token cost ceiling");
  // Exactly 3 model calls: the budget branch must NOT run a 4th (summary) call.
  expect(provider.calls).toBe(3);
});

test("durable edits earn one bounded cost extension before the absolute ceiling", async () => {
  const provider = new EditThenBashProvider(50000);
  const runtime = makeRuntime(provider, 100000, {
    workerProgressExtensionTokens: 50000,
    workerMaxTokenMultiplier: 1.5,
    extraTools: [makeWriteFileStub(dir)],
  });
  const r = await runtime.runTurn(
    "s-progress-extension",
    "implement it",
    new AbortController().signal,
    "orchestration-worker",
    "build",
  );
  expect(r.stoppedReason).toBe("token_budget");
  expect(r.budgetExtensions).toBe(1);
  expect(provider.calls).toBe(3); // normal ceiling was call 2; extension reached the hard 1.5x cap
  expect(r.progressSummary).toContain("Files changed: out.txt");
  expect(r.progressSummary).toContain("edited out.txt");
});

test("interactive turn ignores the worker budget (source is not a worker)", async () => {
  const provider = new UsageProvider(50000); // would trip a 120k worker budget after 3 calls
  const runtime = makeRuntime(provider, 120000);
  // Drive a few rounds, then abort. The point: even though cumulative spend crosses 120k, an
  // interactive `source` ("user") never sets stoppedReason to token_budget.
  const ac = new AbortController();
  const p = runtime.runTurn("s2", "do it", ac.signal, "user", "t");
  await new Promise((res) => setTimeout(res, 50));
  ac.abort();
  const r = await p;
  expect(r.stoppedReason).not.toBe("token_budget");
});

test("empty-completion retry usage is counted toward the worker budget", async () => {
  // First call is billed 50k but returns empty (→ retry); the retry is billed another 50k. The cap
  // (80k) sits above either call alone but below their sum, so the turn must bail ONLY if the
  // billed-but-empty first call is counted. Without that, spend stays at 50k and never trips.
  const provider = new EmptyThenToolProvider(50000);
  const runtime = makeRuntime(provider, 80000);
  const r = await runtime.runTurn(
    "s3",
    "do it",
    new AbortController().signal,
    "orchestration-worker",
    "t3",
  );
  expect(r.stoppedReason).toBe("token_budget");
  // Bailed at the end of the first loop iteration: the empty call + its retry = 2 calls, no more.
  expect(provider.calls).toBe(2);
});

test("incrementalProgressTokens ignores repeated full context and counts growth plus output", () => {
  expect(incrementalProgressTokens({ input: 50000, output: 100 }, undefined)).toBe(100);
  expect(incrementalProgressTokens({ input: 50000, output: 100 }, 50000)).toBe(100);
  expect(incrementalProgressTokens({ input: 56000, output: 100 }, 50000)).toBe(6100);
  // A compacted context establishes a lower baseline without creating fake negative progress.
  expect(incrementalProgressTokens({ input: 20000, output: 100 }, 56000)).toBe(100);
});

test("verificationCommandKey tracks quality commands but ignores exploratory bash", () => {
  expect(verificationCommandKey("run_tests", {})).toBe("run_tests:full");
  expect(verificationCommandKey("run_tests", { filter: "alt-tui" })).toBe("run_tests:alt-tui");
  expect(verificationCommandKey("smoke_run", { command: "cleetus --tui alt" })).toBe(
    "smoke_run:cleetus --tui alt",
  );
  expect(verificationCommandKey("bash", { command: "bun test" })).toBe("bash:bun test");
  expect(verificationCommandKey("bash", { command: "bun run lint" })).toBe("bash:bun run lint");
  expect(verificationCommandKey("bash", { command: "tsc --noEmit" })).toBe("bash:tsc --noEmit");
  expect(verificationCommandKey("bash", { command: "bunx vitest run" })).toBe(
    "bash:bunx vitest run",
  );
  expect(
    verificationCommandKey("bash", { command: "bunx playwright test tests/page.test.ts" }),
  ).toBe("bash:bunx playwright test tests/page.test.ts");
  expect(verificationCommandKey("bash", { command: "rg -n tui src" })).toBeNull();
  expect(verificationCommandKey("read_file", { path: "src/app.ts" })).toBeNull();
  expect(
    verificationCommandKey("bash", {
      command: "CLEETUS_VERIFICATION_BASELINE=1 bun test tests/sandbox/",
    }),
  ).toBe("bash:bun test tests/sandbox/:baseline");
  expect(
    verificationCommandKey("bash", { command: "bun test tests/ui/alt.test.ts 2>&1 | tail -20" }),
  ).toBe("bash:bun test tests/ui/alt.test.ts");
  expect(verificationCommandKey("bash", { command: "bun test tests/ui/alt.test.ts" })).toBe(
    "bash:bun test tests/ui/alt.test.ts",
  );
});

test("render_check key includes the assertion so a changed expectation re-runs", () => {
  const base = { launchCommand: "bun run dev -- --port 5173", url: "http://localhost:5173/chat" };
  const a = verificationCommandKey("render_check", { ...base, expectedText: "No threads yet." });
  const b = verificationCommandKey("render_check", {
    ...base,
    expectedText: "Select or create a thread to begin.",
  });
  // Same route, different assertion → different key (so the cache does not serve a stale result).
  expect(a).not.toBe(b);
  expect(a).toContain("No threads yet.");
  // The port is normalized so the same check on a different port stays one key...
  expect(
    verificationCommandKey("render_check", {
      launchCommand: "bun run dev -- --port 5199",
      url: "http://localhost:5199/chat",
      expectedText: "No threads yet.",
    }),
  ).toBe(a);
  // ...an interaction assertion is part of the identity too.
  expect(
    verificationCommandKey("render_check", {
      ...base,
      expectedText: "No threads yet.",
      expectedControl: "New thread",
      expectedAfterText: "No messages yet.",
    }),
  ).not.toBe(a);
  // An existing browser suite still keys by its command.
  expect(verificationCommandKey("render_check", { command: "bunx playwright test" })).toBe(
    "render_check:suite:bunx playwright test",
  );
});

test("verification evidence distinguishes tests, launch, and browser rendering", () => {
  expect(verificationEvidence("bash", { command: "bun test" })).toBe("test");
  expect(verificationEvidence("smoke_run", { command: "bun run dev" })).toBe("launch");
  expect(verificationEvidence("bash", { command: "bunx playwright test" })).toBe("render");
  expect(verificationSucceeded("smoke_run", true, "✗ exited with code 1")).toBe(false);
  expect(verificationSucceeded("smoke_run", true, "⏱ still running after 5s")).toBe(true);
  expect(verificationClosesSourceLease("test", "bash:bun test")).toBe(true);
  expect(verificationClosesSourceLease("render", "bash:bunx playwright test")).toBe(true);
  expect(verificationClosesSourceLease("quality", "bash:bun run build")).toBe(true);
  expect(verificationClosesSourceLease("quality", "bash:bun run lint")).toBe(false);
  expect(verificationClosesSourceLease("launch", "smoke_run:bun run dev")).toBe(false);
});

test("failed smoke attempts cannot add disposable static-server dependencies", () => {
  expect(smokeInfrastructureInstallBlock("bash", { command: "bun add -d serve" }, true)).toContain(
    "Do not add",
  );
  expect(smokeInfrastructureInstallBlock("bash", { command: "bun add zod" }, true)).toBeNull();
  expect(
    smokeInfrastructureInstallBlock("bash", { command: "bun add -d serve" }, false),
  ).toBeNull();
});

test("completionAuditToolBlock redirects ad-hoc runtime probes to smoke_run", () => {
  expect(
    completionAuditToolBlock("bash", {
      command: "bun run serve.ts &\nsleep 2\ncurl http://localhost:3000/",
    }),
  ).toContain("smoke_run for launch evidence or render_check");
  expect(
    completionAuditToolBlock(
      "write_file",
      { path: "serve.ts", content: "Bun.serve({ port: 1 })" },
      { isNewPath: true },
    ),
  ).toContain("may not create an ad-hoc server");
  expect(completionAuditToolBlock("bash", { command: "bunx vitest run" })).toBeNull();
  expect(completionAuditToolBlock("bash", { command: "cat index.html" })).toBeNull();
});

test("completionAuditToolBlock rejects verification commands that hide the verifier status", () => {
  expect(
    completionAuditToolBlock("bash", {
      command: 'bun test 2>&1; echo "EXIT=$?"',
    }),
  ).toContain("must preserve the verifier's exit status");
  expect(completionAuditToolBlock("bash", { command: "bun test" })).toBeNull();
  expect(
    completionAuditToolBlock("bash", {
      command: "bun test; status=$?; cleanup; exit $status",
    }),
  ).toBeNull();
});

test("completionAuditToolBlock prevents evidence-only test expansion after a passing check", () => {
  expect(
    completionAuditToolBlock(
      "write_file",
      { path: "src/page.smoke.test.ts", content: "test('page', () => {})" },
      { isNewPath: true, hasPassingVerification: true },
    ),
  ).toContain("may not create a new test file");
  expect(
    completionAuditToolBlock(
      "write_file",
      { path: "src/existing.test.ts", content: "test('page', () => {})" },
      { isNewPath: false, hasPassingVerification: true },
    ),
  ).toBeNull();
});

test("verificationFailureIds parses stable Bun and pytest identities", () => {
  expect(
    verificationFailureIds(`
(fail) HostSandbox > denies outside writes [7.18ms]
FAILED tests/ui/test_alt.py::test_header - AssertionError
89 pass, 2 fail`),
  ).toEqual(["HostSandbox > denies outside writes", "tests/ui/test_alt.py::test_header"]);
});

test("compactVerificationForModel reduces passing output to a receipt and summary", () => {
  const detail = `${"noisy passing test\n".repeat(100)}2801 pass\n3 skip\nRan 2804 tests across 90 files.`;
  expect(compactVerificationForModel("bash", true, detail)).toBe(
    "✓ verification passed: bash\n2801 pass\n3 skip\nRan 2804 tests across 90 files.",
  );
});

test("compactVerificationForModel retains failure identities and a bounded tail", () => {
  const detail = `(fail) HostSandbox > denies writes [7ms]\n${"x".repeat(7000)}`;
  const compact = compactVerificationForModel("bash", false, detail);
  expect(compact).toContain("HostSandbox > denies writes");
  expect(compact).toContain("earlier chars omitted");
  expect(compact.length).toBeLessThan(6300);
});

test("reuses identical verification when no structured edit landed", async () => {
  let executions = 0;
  const countingBash: Tool = {
    ...stubBash,
    run: async () => {
      executions++;
      return { ok: true, output: "12 pass\nRan 12 tests across 2 files." };
    },
  };
  const runtime = makeRuntime(new RepeatedVerificationProvider(), 0, {
    extraTools: [countingBash],
  });
  await runtime.runTurn("s-verification-cache", "verify twice");

  expect(executions).toBe(1);
  expect(
    runtime
      .getMessages("s-verification-cache")
      .some(
        (message) =>
          message.role === "tool" && message.content.includes("command was not executed again"),
      ),
  ).toBe(true);
});

test("re-runs a previously failed verification instead of replaying the stale failure", async () => {
  // Same command twice with no tracked-file edit between (the RepeatedVerificationProvider shape).
  // The first run fails the way a Go build-cache sandbox denial does; an ENVIRONMENTAL fix — not a
  // tracked-file edit — makes the second run pass. The epoch guard keys only on tracked edits, so
  // caching the failure would replay it and hide the fix (observed: a model's GOCACHE fix ignored
  // because the failing `go test` result was served from cache). A failed verification must re-run.
  let executions = 0;
  const failThenPassBash: Tool = {
    ...stubBash,
    run: async () => {
      executions++;
      return executions === 1
        ? { ok: false, errorMessage: "open .../go-build/...: operation not permitted" }
        : { ok: true, output: "12 pass\nRan 12 tests across 2 files." };
    },
  };
  const runtime = makeRuntime(new RepeatedVerificationProvider(), 0, {
    extraTools: [failThenPassBash],
  });
  await runtime.runTurn("s-verification-cache-fail", "verify twice");

  // Both verification calls actually executed — the failure was not served from cache.
  expect(executions).toBe(2);
});

test("invalidates verification reuse after a structured edit", async () => {
  let executions = 0;
  const countingBash: Tool = {
    ...stubBash,
    run: async () => {
      executions++;
      return { ok: true, output: "12 pass" };
    },
  };
  const runtime = makeRuntime(new RepeatedVerificationProvider(true), 0, {
    extraTools: [countingBash, makeWriteFileStub(dir)],
  });
  await runtime.runTurn("s-verification-cache-edit", "verify around an edit");

  expect(executions).toBe(2);
});

test("verificationCommandMasksExit detects status-erasing echo/printf commands", () => {
  expect(
    verificationCommandMasksExit("bash", {
      command: 'bun run lint 2>&1 | tail -20; echo "EXIT: $?"',
    }),
  ).toBe(true);
  expect(
    verificationCommandMasksExit("bash", {
      command: "bun test\nprintf 'status=%s\\n' $?",
    }),
  ).toBe(true);
  expect(verificationCommandMasksExit("bash", { command: "bun test 2>&1 | tail -20" })).toBe(false);
  expect(verificationCommandMasksExit("bash", { command: "bun test; git stash pop" })).toBe(true);
  expect(verificationCommandMasksExit("bash", { command: "bun test; rm tmp.test.ts" })).toBe(true);
  expect(
    verificationCommandMasksExit("bash", {
      command: "bun test; status=$?; rm tmp.test.ts; exit $status",
    }),
  ).toBe(false);
  expect(verificationCommandMasksExit("run_tests", {})).toBe(false);
});

test("runTurn returns unresolved verification facts even when the model finishes normally", async () => {
  const provider = new FailedVerificationThenFinishProvider();
  const runtime = makeRuntime(provider, 0, { extraTools: [failingBash] });
  const result = await runtime.runTurn(
    "s-verification",
    "run the suite",
    new AbortController().signal,
    "orchestration-worker",
    "verify",
  );

  expect(result.stoppedReason).toBeUndefined();
  expect(result.assistantText).toContain("unrelated");
  expect(result.verificationResults).toEqual([
    {
      key: "bash:bun test",
      command: "bash",
      ok: false,
      detail: "tsc error",
      evidence: "test",
      scope: "full",
      baseline: false,
      failureIds: [],
    },
  ]);
});

test("repeated full input context does not falsely trip no_progress", async () => {
  const provider = new UsageProvider(50000);
  const runtime = makeRuntime(provider, 160000, { workerNoProgressTokens: 1 });
  const r = await runtime.runTurn(
    "s-repeat",
    "do it",
    new AbortController().signal,
    "orchestration-worker",
    "repeat",
  );
  // Billed spend still counts every call and ends the turn. The edit-progress watchdog does not
  // mistake the same 50k input context being reported repeatedly for 200k of novel investigation.
  expect(r.stoppedReason).toBe("token_budget");
  expect(provider.calls).toBe(4);
});

test("stops a worker with no_progress when novel context growth crosses the threshold", async () => {
  const provider = new GrowingUsageProvider(50000);
  // The initial 50k task prompt is setup. Calls 2-4 exhaust one 150k inspection window and grant
  // grace; calls 5-7 exhaust the second window, proving one slow investigation is not enough to
  // terminate the worker.
  const runtime = makeRuntime(provider, 10_000_000, { workerNoProgressTokens: 120000 });
  const r = await runtime.runTurn(
    "s4",
    "do it",
    new AbortController().signal,
    "orchestration-worker",
    "t4",
  );
  expect(r.stoppedReason).toBe("no_progress");
  expect(r.assistantText).toContain("two full inspection budgets elapsed");
  expect(provider.calls).toBe(7);
});

test("resets the no-progress counter when an edit lands (runs to token_budget instead)", async () => {
  const provider = new EditThenBashProvider(50000);
  // Call 1 lands a diff (write_file). Repeated full input usage on calls 2-3 does not create fake
  // no-progress growth, while billed spend still reaches the independent 150k total ceiling.
  const runtime = makeRuntime(provider, 150000, {
    workerNoProgressTokens: 120000,
    extraTools: [makeWriteFileStub(dir)],
  });
  const r = await runtime.runTurn(
    "s5",
    "do it",
    new AbortController().signal,
    "orchestration-worker",
    "t5",
  );
  expect(r.stoppedReason).toBe("token_budget");
  expect(r.stoppedReason).not.toBe("no_progress");
  expect(provider.calls).toBe(3);
});

test("loop-guard hard-block refuses repeated failing command pre-dispatch (#154)", async () => {
  const providers = new ProviderRegistry();
  const provider = new RepeatFailProvider();
  providers.register("p", provider);
  const tools = new ToolRegistry();
  let bashRuns = 0;
  tools.register({
    ...failingBash,
    run: async () => {
      bashRuns++;
      return { ok: false, errorMessage: "tsc error" };
    },
  });
  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 30,
    // cmdFailAbort disabled here to isolate the pre-dispatch block behavior (#154) under test;
    // otherwise the plain-session command-fail-streak abort (default 6) would cut the turn short
    // before the block gate's effect (many more model requests than dispatches) is observable.
    loopGuard: () => ({ ...DEFAULT_LOOP_GUARD, blockThreshold: 2, cmdFailAbort: 0 }),
  });
  await runtime.runTurn("s3", "build it", new AbortController().signal, "user", "t");
  // The model asked for `bun run build` ~30 times, but once the gate engages after the second
  // fail-warning the tool stops executing — real dispatches trail model requests by a wide
  // margin (observed: 10 dispatches vs 31 requests), not merely by the trailing summary call.
  expect(bashRuns).toBeLessThan(provider.calls - 10);
  expect(bashRuns).toBeGreaterThan(0);
});

/** Finishes every turn immediately with a short reply and no tool calls — one model call per
 *  runTurn, so a fresh router.select()/assembleMessages() pair happens exactly once per turn. */
class SimpleProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Notices emitted by budgetUpgradeNotice all start with this exact prefix (see
 *  src/agent/context/budget.ts); distinct from the unrelated "Large context" warn-once notice
 *  emitted by maybeWarnInputSize, so filtering on it can't accidentally count the wrong notice. */
function upgradeNotices(log: EventLog, sessionId: string): string[] {
  return log
    .query(sessionId)
    .filter(
      (e) =>
        e.type === "notice" && /context window detected/.test((e.payload as { text: string }).text),
    )
    .map((e) => (e.payload as { text: string }).text);
}

test("budget-upgrade notice fires once per provider:model pair, not on routing alternation", async () => {
  const provider = new SimpleProvider();
  const providers = new ProviderRegistry();
  providers.register("p", provider);
  const tools = new ToolRegistry();

  // Router alternates the routed pair on every turn: small-m, large-m, small-m, large-m.
  let turn = 0;
  const router: Router = {
    select: () => {
      const choice =
        turn % 2 === 0 ? { provider: "p", model: "small-m" } : { provider: "p", model: "large-m" };
      turn++;
      return { choice, tier: null, reason: "alt" };
    },
    finishPass: () => null,
  };

  // The routed pair's own window is fixed and known throughout: small-m=8192, large-m=131072
  // (real per-pair evidence, keyed by the `model` arg). The NULLARY ("active pair") read is a
  // different, unrelated signal — it starts unknown and resolves to a fixed value on its second
  // call, mirroring how the active model's own window detection is independent of which pair a
  // given call actually routed to. Pre-fix, assembleMessages ignores the routed pair entirely and
  // reads this nullary signal into a single session-wide slot: the moment it resolves gets
  // attributed to WHATEVER pair happens to be routed on that turn, even though that pair's real
  // per-pair window never changed — a spurious, misattributed notice.
  let nullaryCalls = 0;
  const modelContextLength = (m?: string): number | undefined => {
    if (m === undefined) return nullaryCalls++ === 0 ? undefined : 131072;
    return m === "small-m" ? 8192 : 131072;
  };

  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router,
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 5,
    modelContextLength,
  });

  await runtime.runTurn("S", "one");
  await runtime.runTurn("S", "two");
  await runtime.runTurn("S", "three");
  await runtime.runTurn("S", "four");

  // Neither pair's OWN window ever changed (small-m stays 8192, large-m stays 131072 across every
  // visit), so no upgrade notice should fire at all.
  expect(upgradeNotices(log, "S")).toEqual([]);
});

test("budget-upgrade notice still fires when the SAME pair's window grows", async () => {
  const provider = new SimpleProvider();
  const providers = new ProviderRegistry();
  providers.register("p", provider);
  const tools = new ToolRegistry();

  // First observation of the pair is unknown; every observation after is known — the classic
  // one-shot "context window detected" case, now keyed per pair instead of per session.
  let calls = 0;
  const modelContextLength = (): number | undefined => (calls++ === 0 ? undefined : 131072);

  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "cold-m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 5,
    modelContextLength,
  });

  await runtime.runTurn("S", "one");
  await runtime.runTurn("S", "two");

  const notices = upgradeNotices(log, "S");
  expect(notices.length).toBe(1);
  expect(notices[0]).toContain("cold-m");
});

test("budget derives from the ROUTED model's window", async () => {
  const provider = new SimpleProvider();
  const providers = new ProviderRegistry();
  providers.register("p", provider);
  const tools = new ToolRegistry();

  // The ROUTED pair (small-m) genuinely has an 8192 window. The nullary ("active") read reports
  // a much bigger 131072 — simulating smart routing down to a small model while some other
  // active/default model has a huge window. Only the routed pair's window may govern the budget.
  const modelContextLength = (m?: string): number | undefined => (m === "small-m" ? 8192 : 131072);

  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "small-m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 5,
    modelContextLength,
    context: () => ({
      ...DEFAULT_CONTEXT,
      responseReserveTokens: 0,
    }),
  });

  // Three turns (~2000 tokens each, ~6000 tokens total) — comfortably over an 8192-derived
  // budget's high-water (~4565 tokens: the newest turn alone is never trimmed, per
  // computeRecentBoundary, so at least one turn of history must sit BEFORE the live turn for a
  // trim to be possible at all) but nowhere near a 131072-capped-at-96000 budget's high-water
  // (~71700 tokens). Pre-fix (budget sized from the nullary 131072 read) this never trims.
  await runtime.runTurn("S", "x".repeat(8000));
  await runtime.runTurn("S", "x".repeat(8000));
  await runtime.runTurn("S", "x".repeat(8000));

  const events = log.query("S");
  expect(events.some((e) => e.type === "compaction_start" || e.type === "compaction_end")).toBe(
    true,
  );
});
