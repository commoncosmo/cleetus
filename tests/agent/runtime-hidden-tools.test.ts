import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import { DEFAULT_LOOP_GUARD } from "../../src/config/loop-guard";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

/** Calls `git_status` (a registered-but-hidden tool at small capability, since it starts with
 *  `git_` and is not in SMALL_TOOL_ROSTER) every single step, forever — models the small model
 *  hammering a tool it keeps hallucinating is available. Captures the messages replayed on the
 *  LAST call so the test can inspect the accumulated tool-result history. */
class HiddenToolForeverProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.lastMessages = opts.messages;
    yield {
      type: "tool-call",
      call: { id: `c${this.calls}`, name: "git_status", args: {} },
    };
    yield { type: "finish", reason: "tool-calls" };
  }
  async embed() {
    return [0];
  }
}

function gitStatusTool(onRun?: () => void): Tool {
  return {
    name: "git_status",
    description: "git status",
    mutates: false,
    parameters: { type: "object", properties: {} },
    serialize: () => "git_status",
    run: async (): Promise<ToolResult> => {
      onRun?.();
      return { ok: true, output: "clean" };
    },
  };
}

/** A real, in-roster tool (small capability sees `bash`) standing in for the harmless sibling
 *  call that shares a batch with hidden-tool rejections. */
function bashStubTool(onRun?: () => void): Tool {
  return {
    name: "bash",
    description: "run a shell command",
    mutates: true,
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    serialize: (args) => `bash(${(args as { command?: string })?.command ?? ""})`,
    run: async (): Promise<ToolResult> => {
      onRun?.();
      return { ok: true, output: "ran" };
    },
  };
}

/** Emits ONE assistant step containing a batch of three tool calls: two hidden `git_status`
 *  rejections followed by one real, in-roster `bash` call — modeling the exact shape the
 *  hidden-tools abort must not truncate mid-batch. */
class HiddenToolBatchProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.lastMessages = opts.messages;
    yield { type: "tool-call", call: { id: "h1", name: "git_status", args: {} } };
    yield { type: "tool-call", call: { id: "h2", name: "git_status", args: {} } };
    yield {
      type: "tool-call",
      call: { id: "r1", name: "bash", args: { command: "echo hi" } },
    };
    yield { type: "finish", reason: "tool-calls" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
let providers: ProviderRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-hidden-rt-"));
  log = new EventLog(join(dir, "events.db"));
  providers = new ProviderRegistry();
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  overrides: Partial<AgentRuntimeOptions>,
  onRun?: () => void,
) {
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(gitStatusTool(onRun));
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "small-m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 20,
    ...overrides,
  });
}

describe("AgentRuntime hidden-tool loop abort (WS5 N3)", () => {
  it("hidden-tool rejections warn at threshold and abort the turn at 2x", async () => {
    const provider = new HiddenToolForeverProvider();
    const runtime = makeRuntime(provider, {
      capability: () => "small",
      loopGuard: () => ({ ...DEFAULT_LOOP_GUARD, hiddenRepeatThreshold: 2 }),
    });
    const result = await runtime.runTurn("s1", "check git status");

    // Provider never made it to loop 20 (maxToolLoops) — the guard aborted the turn early.
    expect(provider.calls).toBe(4); // 2x hiddenRepeatThreshold(2)

    // Every hidden-tool call logs a tool_unavailable error, regardless of whether it also
    // warned — so the log (not the last replayed prompt, which never gets a call AFTER the
    // 4th rejection since the turn aborts instead of looping again) gives the true total.
    const events = log.query("s1");
    const rejections = events.filter(
      (e) => e.type === "error" && (e.payload as { phase?: string }).phase === "tool_unavailable",
    );
    expect(rejections.length).toBe(4);

    const toolResults = provider.lastMessages.filter((m) => m.role === "tool");
    const warned = toolResults.filter((m) => (m.content ?? "").includes("<loop-warning>"));
    expect(warned.length).toBeGreaterThanOrEqual(1);
    expect(warned[0]?.content ?? "").toContain("not available in this session");

    expect(result.stoppedReason).toBe("hidden_tools");
  });

  it("aborts once the window saturates even when 2x threshold exceeds windowSize", async () => {
    // window_size: 4, hiddenRepeatThreshold: 3 → 2x threshold (6) exceeds windowSize (4), so
    // hiddenRepeats() (capped at windowSize) can never literally reach 2x. Without saturating
    // the trigger at windowSize, this config would never abort and would burn all maxToolLoops.
    const provider = new HiddenToolForeverProvider();
    const runtime = makeRuntime(provider, {
      capability: () => "small",
      loopGuard: () => ({ ...DEFAULT_LOOP_GUARD, windowSize: 4, hiddenRepeatThreshold: 3 }),
      maxToolLoops: 20,
    });
    const result = await runtime.runTurn("s1", "check git status");

    // The window saturates (all 4 slots hidden) well before maxToolLoops(20) — the guard
    // still fast-aborts instead of grinding through every remaining loop.
    expect(provider.calls).toBe(4);
    expect(result.stoppedReason).toBe("hidden_tools");
  });

  it("standard capability never records hidden rejections", async () => {
    const provider = new HiddenToolForeverProvider();
    let ran = 0;
    const runtime = makeRuntime(
      provider,
      {
        capability: () => "standard",
        loopGuard: () => ({ ...DEFAULT_LOOP_GUARD, hiddenRepeatThreshold: 2 }),
        maxToolLoops: 3,
      },
      () => ran++,
    );
    const result = await runtime.runTurn("s1", "check git status");

    // At standard capability git_status is a real, dispatched tool — it runs every loop.
    expect(ran).toBe(3);

    const toolResults = provider.lastMessages.filter((m) => m.role === "tool");
    expect(
      toolResults.some((m) => (m.content ?? "").includes("not available in this session")),
    ).toBe(false);
    expect(toolResults.some((m) => (m.content ?? "").includes("<loop-warning>"))).toBe(false);
    expect(result.stoppedReason).toBe("loop_limit");
  });

  it("drains the rest of the batch before aborting — no dangling tool_calls id survives", async () => {
    // windowSize 4, hiddenRepeatThreshold 1 → saturation min(2*1, 4) = 2, hit on the SECOND
    // hidden rejection within the single batch [h1 hidden, h2 hidden, r1 real].
    const provider = new HiddenToolBatchProvider();
    let bashRan = false;
    providers.register("lm", provider);
    const tools = new ToolRegistry();
    tools.register(gitStatusTool());
    tools.register(
      bashStubTool(() => {
        bashRan = true;
      }),
    );
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "small-m" }),
      systemPrompt: () => "sys",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 20,
      capability: () => "small",
      loopGuard: () => ({ ...DEFAULT_LOOP_GUARD, windowSize: 4, hiddenRepeatThreshold: 1 }),
    });

    const result = await runtime.runTurn("s1", "check git status and run a command");

    // (a) the turn ends with stoppedReason: "hidden_tools".
    expect(result.stoppedReason).toBe("hidden_tools");

    // Only ONE model step ran — the batch fully drained and the outer loop broke right after,
    // so the provider was never asked for a follow-up step.
    expect(provider.calls).toBe(1);

    // (b) EVERY tool call id in the batch has a matching tool-role result in session history —
    // no dangling tool_calls id persists for a follow-up turn to replay.
    const messages = runtime.getMessages("s1");
    const toolMsgsById = new Map(
      messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m]),
    );
    for (const id of ["h1", "h2", "r1"]) {
      expect(toolMsgsById.has(id)).toBe(true);
    }

    // (c) the third (real) call actually resolved — it executed rather than being left dangling.
    expect(bashRan).toBe(true);
    expect(toolMsgsById.get("r1")?.content ?? "").toContain("ran");
  });
});
