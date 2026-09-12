import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import { DEFAULT_LOOP_GUARD } from "../../src/config/loop-guard";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

/** Succeeds on every call (a landed edit) — used to prove edits don't reset the cmd-fail streak. */
const succeedingEdit: Tool = {
  name: "edit_file",
  description: "",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  mutates: true,
  serialize: () => "edit",
  run: async (): Promise<ToolResult> => ({
    ok: true,
    diff: { path: "f.ts", before: "a", after: "b" },
  }),
};

/** Alternates a FAILING bash and a SUCCESSFUL edit each loop (the ct14 shape: cosmetic edits
 *  between the same failing command). */
class FailCmdWithEditsProvider implements Provider {
  calls = 0;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    const bash = this.calls % 2 === 1;
    yield {
      type: "tool-call",
      call: bash
        ? { id: `c${this.calls}`, name: "bash", args: { command: "x" } }
        : { id: `c${this.calls}`, name: "edit_file", args: { path: "f.ts" } },
    };
    yield { type: "finish", reason: "tool-calls", usage: { input: 10, output: 0 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

/** Always requests the same failing command (a stable signature across loops); never finishes
 *  on its own. */
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
      call: { id: `c${this.calls}`, name: "bash", args: { command: "x" } },
    };
    yield { type: "finish", reason: "tool-calls", usage: { input: 10, output: 0 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

/** Fails the same command once, then ends the turn cleanly (no further tool call). Used to
 *  drive a SECOND turn on a session that already hit a thrash stop, without thrashing again. */
class FailOnceThenStopProvider implements Provider {
  calls = 0;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: "tool-call",
        call: { id: "c1", name: "bash", args: { command: "x" } },
      };
      yield { type: "finish", reason: "tool-calls", usage: { input: 10, output: 0 }, model: "m" };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Bash stub that always fails — drives the loop-guard thrash streak. */
const failingBash: Tool = {
  name: "bash",
  description: "",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  mutates: true,
  serialize: () => "bash",
  run: async (): Promise<ToolResult> => ({ ok: false, errorMessage: "boom" }),
};

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-thrash-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(opts: Partial<AgentRuntimeOptions> = {}) {
  const providers = new ProviderRegistry();
  const provider = new RepeatFailProvider();
  providers.register("p", provider);
  const tools = new ToolRegistry();
  tools.register(failingBash);
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
    loopGuard: () => DEFAULT_LOOP_GUARD,
    workerThrashRepeats: () => 4,
    ...opts,
  });
  return { runtime, provider };
}

test("a worker turn stops with 'thrash' after one command fails worker_thrash_repeats times", async () => {
  const { runtime } = makeRuntime();
  const r = await runtime.runTurn(
    "s1",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "t1",
  );
  expect(r.stoppedReason).toBe("thrash");
});

test("a plain (non-worker) session stops with 'thrash' at the default cmd_fail_abort", async () => {
  const { runtime } = makeRuntime(); // DEFAULT_LOOP_GUARD.cmdFailAbort = 6
  const r = await runtime.runTurn("s2", "go", new AbortController().signal, "user", "t2");
  expect(r.stoppedReason).toBe("thrash");
});

test("cmd_fail_abort: 0 disables the plain-session thrash stop", async () => {
  const { runtime } = makeRuntime({
    loopGuard: () => ({ ...DEFAULT_LOOP_GUARD, cmdFailAbort: 0 }),
  });
  const ac = new AbortController();
  const p = runtime.runTurn("s2b", "go", ac.signal, "user", "t2b");
  await new Promise((res) => setTimeout(res, 50));
  ac.abort();
  const r = await p;
  expect(r.stoppedReason).not.toBe("thrash");
});

test("workerThrashRepeats dep absent → no thrash stop", async () => {
  const { runtime } = makeRuntime({ workerThrashRepeats: undefined });
  const ac = new AbortController();
  const p = runtime.runTurn("s3", "go", ac.signal, "orchestration-worker", "t3");
  await new Promise((res) => setTimeout(res, 50));
  ac.abort();
  const r = await p;
  expect(r.stoppedReason).not.toBe("thrash");
});

test("a successful edit between failures does NOT reset the streak (ct14 shape)", async () => {
  const providers = new ProviderRegistry();
  providers.register("p", new FailCmdWithEditsProvider());
  const tools = new ToolRegistry();
  tools.register(failingBash);
  tools.register(succeedingEdit);
  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 40,
    loopGuard: () => DEFAULT_LOOP_GUARD, // cmdFailAbort 6
  });
  const r = await runtime.runTurn("s4", "go", new AbortController().signal, "user", "t4");
  expect(r.stoppedReason).toBe("thrash"); // 6 failing `bash x` calls despite edits between
});

test("a thrash stop clears the cmd-fail streak so the next turn's retry does not thrash immediately", async () => {
  const providers = new ProviderRegistry();
  providers.register("p", new RepeatFailProvider());
  const tools = new ToolRegistry();
  tools.register(failingBash);
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
    loopGuard: () => DEFAULT_LOOP_GUARD, // cmdFailAbort 6
  });

  const r1 = await runtime.runTurn("s5", "go", new AbortController().signal, "user", "t5a");
  expect(r1.stoppedReason).toBe("thrash");

  // Same session (same LoopGuard instance, same "cmd:x" signature) — but this turn's provider
  // fails the command only ONCE before ending cleanly. Without clearing the streak on the
  // thrash stop, this single failure would push the already-6-deep streak to 7 and re-thrash
  // on the very first tool call of the new turn.
  providers.register("p", new FailOnceThenStopProvider());
  const r2 = await runtime.runTurn("s5", "go", new AbortController().signal, "user", "t5b");
  expect(r2.stoppedReason).not.toBe("thrash");
});
