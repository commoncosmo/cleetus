import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import type { StreamWatchdogConfig } from "../../src/config/stream-watchdog";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

/** Emits one token then goes silent forever (honors abort) — a genuine hang. */
class SilentHangProvider implements Provider {
  calls: ChatOptions[] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls.push(opts);
    yield { type: "text-delta", text: "hi" };
    await new Promise<void>((_resolve, reject) => {
      if (opts.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      opts.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Streams reasoning forever (continuous activity) — a runaway only the ceiling can catch. */
class InfiniteReasoningProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    while (true) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      yield { type: "reasoning-delta", text: "x" };
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  async embed() {
    return [0];
  }
}

/** Emits tool-call-delta heartbeats under the idle threshold, then finishes — productive. */
class ToolDeltaProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < 6; i++) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      yield { type: "tool-call-delta", index: 0 };
      await new Promise((r) => setTimeout(r, 20));
    }
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** A normal, bounded call that finishes promptly. */
class BoundedProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    yield { type: "reasoning-delta", text: "thinking" };
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Emits nothing for `delayMs`, then a first token, then finishes — a slow first token / model load. */
class SlowFirstTokenProvider implements Provider {
  constructor(private delayMs: number) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Never emits a first token; hangs honoring abort — a stalled prefill / stuck model load. */
class NeverFirstTokenProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    await new Promise<void>((_resolve, reject) => {
      if (opts.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      opts.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Streams a degenerate short-unit text loop — the WS3.4 failure mode. 200 × 6 = 1200 chars. */
class RepeatingTextProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < 200; i++) yield { type: "text-delta", text: "we,we," };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Streams the same degenerate loop on the REASONING channel (GLM-style token loop). */
class RepeatingReasoningProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < 200; i++) yield { type: "reasoning-delta", text: "we,we," };
    yield { type: "text-delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Repetition split by a tool-call delta: 240 chars per segment (below the 300 span floor),
 *  480 combined (above it) — only a tail reset keeps this from firing. */
class ToolSplitRepetitionProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < 80; i++) yield { type: "text-delta", text: "ha," };
    yield { type: "tool-call-delta", index: 0 };
    for (let i = 0; i < 80; i++) yield { type: "text-delta", text: "ha," };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Family-adapter shape: tool-call markup streams as TEXT deltas, then repetitive but
 *  LEGITIMATE args content (18 identical 21-char lines = 378 chars ≥ the 300 floor; the
 *  repeat count is chosen so a throttled check lands mid-streak, at cumulative unit 17,
 *  BEFORE the closing "</tool_call>" delta arrives and breaks the end-anchor — otherwise
 *  the closing markup's arrival coincides with the next check and masks the false positive). */
class MarkupThenRepetitiveArgsProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: '<tool_call>{"name":"write_file","args":{"content":"' };
    for (let i = 0; i < 18; i++) yield { type: "text-delta", text: "<td>placeholder</td>\n" };
    yield { type: "text-delta", text: '"}}</tool_call>' };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Same shape, but the markup + repetitive args stream on the REASONING channel (models that
 *  narrate tool calls inside a thinking channel), followed by a normal text answer. */
class MarkupThenRepetitiveArgsReasoningProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    yield {
      type: "reasoning-delta",
      text: '<tool_call>{"name":"write_file","args":{"content":"',
    };
    for (let i = 0; i < 18; i++) yield { type: "reasoning-delta", text: "<td>placeholder</td>\n" };
    yield { type: "reasoning-delta", text: '"}}</tool_call>' };
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Streams a ≥20-char reasoning line many times, interleaved with unique filler (non-consecutive)
 *  — the ct12 rumination shape. Never emits a tool call or finish on its own. */
class RuminatingProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < 40; i++) {
      yield { type: "reasoning-delta", text: `unique filler thought number ${i} here\n` };
      yield { type: "reasoning-delta", text: "Let me implement this now.\n" };
    }
    yield { type: "text-delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Reproduces codex10 step 3: a whole multi-kilobyte planning block repeats exactly while the
 * stream remains continuously active, so neither the idle timer nor short-unit detector applies. */
class LongReasoningCycleProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    const cycle = Array.from(
      { length: 72 },
      (_, i) =>
        `state-slot-${String(i).padStart(3, "0")}: map this distinct handler and dependency`,
    ).join("\n");
    for (let copy = 0; copy < 5; copy++) {
      for (let offset = 0; offset < cycle.length; offset += 41) {
        yield { type: "reasoning-delta", text: cycle.slice(offset, offset + 41) };
      }
    }
    yield { type: "text-delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-wd-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  watchdog: StreamWatchdogConfig,
  tools = new ToolRegistry(),
): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 3,
    streamWatchdog: () => watchdog,
  });
}

function watchdogNotices(sessionId: string) {
  return log
    .query(sessionId)
    .filter((e) => e.type === "notice")
    .filter((n) => (n.payload as { kind?: string }).kind === "stream_watchdog")
    .map((n) => (n.payload as { text: string }).text);
}

describe("AgentRuntime stream watchdog (idle + ceiling)", () => {
  it("retries a silent stream once on the same model and discards the failed draft", async () => {
    class RecoversProvider extends SilentHangProvider {
      override async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
        if (this.calls.length === 0) {
          yield* super.chat(opts);
          return;
        }
        this.calls.push(opts);
        yield { type: "text-delta", text: "Recovered answer" };
        yield { type: "finish", reason: "stop" };
      }
    }
    const provider = new RecoversProvider();
    const runtime = makeRuntime(provider, {
      enabled: true,
      firstTokenMs: 100000,
      noProgressMs: 30,
      maxCallMs: 100000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const result = await runtime.runTurn("S", "go");
    expect(result.assistantText).toBe("Recovered answer");
    expect(result.stoppedReason).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.model).toBe(provider.calls[0]!.model);
    expect(provider.calls[1]!.messages).toEqual(provider.calls[0]!.messages);
    expect(provider.calls[0]!.signal!.aborted).toBe(true);
    expect(provider.calls[1]!.signal!.aborted).toBe(false);
    expect(watchdogNotices("S")).toHaveLength(0);
  });

  it("stops after one idle retry and grants a fresh retry to the next user turn", async () => {
    const provider = new SilentHangProvider();
    const runtime = makeRuntime(provider, {
      enabled: true,
      firstTokenMs: 100000,
      noProgressMs: 50,
      maxCallMs: 100000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const res = await runtime.runTurn("S", "go");
    const texts = watchdogNotices("S");
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("no output");
    expect(res.assistantText).toContain("stopped");
    expect(res.stoppedReason).toBe("stream_watchdog");
    expect(provider.calls).toHaveLength(2);
    await runtime.runTurn("S", "try again");
    expect(provider.calls).toHaveLength(4);
  });

  it("does not retry a user cancellation during a silent stream", async () => {
    const provider = new SilentHangProvider();
    const abort = new AbortController();
    const runtime = makeRuntime(provider, {
      enabled: true,
      firstTokenMs: 100000,
      noProgressMs: 100000,
      maxCallMs: 100000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const timer = setTimeout(() => abort.abort(), 20);
    try {
      const result = await runtime.runTurn("S", "go", abort.signal);
      expect(result.stoppedReason).toBe("cancelled");
      expect(provider.calls).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it("preserves completed tools, discards partial calls, and does not renew the retry after progress", async () => {
    class ToolThenHangProvider extends SilentHangProvider {
      override async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
        const call = this.calls.length;
        if (call === 1 || call === 3) {
          yield { type: "tool-call", call: { id: `partial-${call}`, name: "echo", args: {} } };
          yield* super.chat(opts);
          return;
        }
        this.calls.push(opts);
        yield { type: "tool-call", call: { id: `complete-${call}`, name: "echo", args: {} } };
        yield { type: "finish", reason: "tool-calls" };
      }
    }
    const provider = new ToolThenHangProvider();
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "test",
      parameters: { type: "object", properties: {} },
      serialize: () => "echo",
      run: async () => {
        executions++;
        return { ok: true, output: "ok" };
      },
    });
    const runtime = makeRuntime(
      provider,
      {
        enabled: true,
        firstTokenMs: 100000,
        noProgressMs: 30,
        maxCallMs: 100000,
        repetitionRepeats: 0,
        reasoningLoopLines: 0,
      },
      tools,
    );
    const result = await runtime.runTurn("S", "go");
    expect(executions).toBe(2);
    expect(provider.calls).toHaveLength(4);
    expect(result.stoppedReason).toBe("stream_watchdog");
    expect(
      log
        .query("S")
        .filter((event) => event.type === "tool_call_start")
        .map((event) => (event.payload as { call: { id: string } }).call.id),
    ).toEqual(["complete-0", "complete-2"]);
  });

  it("does NOT abort a slow first token within the first-token budget", async () => {
    // Prefill gap (~80ms) exceeds noProgressMs (30) but is under firstTokenMs (300): must survive.
    const runtime = makeRuntime(new SlowFirstTokenProvider(80), {
      enabled: true,
      firstTokenMs: 300,
      noProgressMs: 30,
      maxCallMs: 100000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
    expect(res.assistantText).toBe("done");
  });

  it("aborts a stalled prefill via the first-token timer with a distinct notice", async () => {
    const runtime = makeRuntime(new NeverFirstTokenProvider(), {
      enabled: true,
      firstTokenMs: 40,
      noProgressMs: 100000,
      maxCallMs: 100000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const res = await runtime.runTurn("S", "go");
    const texts = watchdogNotices("S");
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("first token");
    expect(texts[0]).not.toContain("no output");
    expect(res.assistantText).toContain("stopped");
  });

  it("aborts a continuously-streaming runaway via the ceiling timer", async () => {
    const runtime = makeRuntime(new InfiniteReasoningProvider(), {
      enabled: true,
      firstTokenMs: 100000,
      noProgressMs: 100000,
      maxCallMs: 50,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const res = await runtime.runTurn("S", "go");
    const texts = watchdogNotices("S");
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("runaway");
    expect(res.assistantText).toContain("stopped");
  });

  it("does NOT abort productive tool-call streaming that exceeds the idle window in total", async () => {
    const runtime = makeRuntime(new ToolDeltaProvider(), {
      enabled: true,
      firstTokenMs: 100000,
      noProgressMs: 50,
      maxCallMs: 100000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
    // Heartbeats reset the idle timer and are not themselves logged as events.
    const types = new Set<string>(log.query("S").map((e) => e.type));
    expect(types.has("tool-call-delta")).toBe(false);
    expect(res.assistantText).not.toContain("stopped");
  });

  it("does not fire when disabled (call completes normally)", async () => {
    const runtime = makeRuntime(new BoundedProvider(), {
      enabled: false,
      firstTokenMs: 1,
      noProgressMs: 1,
      maxCallMs: 1,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
    });
    const res = await runtime.runTurn("S", "go");
    expect(res.assistantText).toBe("done");
    expect(watchdogNotices("S").length).toBe(0);
  });
});

describe("AgentRuntime stream watchdog (repetition)", () => {
  // Timers held wide open so only the repetition rule can fire.
  const timersOff = {
    enabled: true,
    firstTokenMs: 100000,
    noProgressMs: 100000,
    maxCallMs: 100000,
    reasoningLoopLines: 0,
  };

  it("aborts a degenerate text loop with a repetition notice and discards the garbage", async () => {
    const runtime = makeRuntime(new RepeatingTextProvider(), {
      ...timersOff,
      repetitionRepeats: 12,
    });
    const res = await runtime.runTurn("S", "go");
    const texts = watchdogNotices("S");
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("repeating output");
    // Only the short parenthesized note persists; the garbage never enters history.
    expect(res.assistantText).toBe("(stopped: model emitted degenerate repeating output)");
  });

  it("aborts a degenerate reasoning loop (channels detected independently)", async () => {
    const runtime = makeRuntime(new RepeatingReasoningProvider(), {
      ...timersOff,
      repetitionRepeats: 12,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(1);
    expect(res.assistantText).toContain("stopped");
  });

  it("does NOT abort when repetition is split by a tool-call delta (tails reset)", async () => {
    const runtime = makeRuntime(new ToolSplitRepetitionProvider(), {
      ...timersOff,
      repetitionRepeats: 12,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
    expect(res.assistantText).toContain("ha,");
  });

  it("streams the same loop to completion when repetition_repeats is 0", async () => {
    const runtime = makeRuntime(new RepeatingTextProvider(), {
      ...timersOff,
      repetitionRepeats: 0,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
    expect(res.assistantText.length).toBe(1200);
  });

  it("does NOT abort legitimate repetitive tool-call-markup args streamed as TEXT deltas " +
    "(family-adapter models)", async () => {
    const runtime = makeRuntime(new MarkupThenRepetitiveArgsProvider(), {
      ...timersOff,
      repetitionRepeats: 12,
    });
    await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
  });

  it("does NOT abort legitimate repetitive tool-call-markup args streamed as REASONING deltas " +
    "(family-adapter models)", async () => {
    const runtime = makeRuntime(new MarkupThenRepetitiveArgsReasoningProvider(), {
      ...timersOff,
      repetitionRepeats: 12,
    });
    await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
  });
});

describe("AgentRuntime stream watchdog (rumination)", () => {
  const timersOff = {
    enabled: true,
    firstTokenMs: 100000,
    noProgressMs: 100000,
    maxCallMs: 100000,
    repetitionRepeats: 0, // keep the WS3.4 detector out of the way
  };

  it("aborts a reasoning-loop with a rumination notice and discards the garbage", async () => {
    const runtime = makeRuntime(new RuminatingProvider(), {
      ...timersOff,
      reasoningLoopLines: 12,
    });
    const res = await runtime.runTurn("S", "go");
    const texts = watchdogNotices("S");
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("repeating the same reasoning");
    expect(res.assistantText).toBe(
      "(stopped: model looped on the same reasoning without progressing)",
    );
    expect(res.stoppedReason).toBe("stream_watchdog");
  });

  it("streams the same reasoning loop to completion when reasoning_loop_lines is 0", async () => {
    const runtime = makeRuntime(new RuminatingProvider(), {
      ...timersOff,
      reasoningLoopLines: 0,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
    expect(res.assistantText).toBe("answer");
  });

  it("does NOT abort legitimate repetitive tool-call-markup args streamed as REASONING deltas " +
    "(rumination detector respects the same markup suspension as WS3.4)", async () => {
    // Same provider as the WS3.4 markup-suspension test, but with the WS3.4 repetition detector
    // OFF (repetitionRepeats: 0, from timersOff) and the RUMINATION detector on instead. The
    // <tool_call>-wrapped args repeat the same ≥20-char line 18 times — well past
    // reasoningLoopLines (12) — so a rumination push that ignores the markup latch would
    // false-fire on a legitimate write_file call.
    const runtime = makeRuntime(new MarkupThenRepetitiveArgsReasoningProvider(), {
      ...timersOff,
      reasoningLoopLines: 12,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S").length).toBe(0);
    expect(res.assistantText).toBe("done");
  });
});

describe("AgentRuntime stream watchdog (exact long reasoning cycle)", () => {
  it("stops a multi-kilobyte exact cycle and reports the distinct cause", async () => {
    const runtime = makeRuntime(new LongReasoningCycleProvider(), {
      enabled: true,
      firstTokenMs: 100000,
      noProgressMs: 100000,
      maxCallMs: 100000,
      repetitionRepeats: 12,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 3,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S")).toEqual([expect.stringContaining("exact long reasoning cycle")]);
    expect(res.assistantText).toContain("exact long reasoning cycle");
    expect(res.stoppedReason).toBe("stream_watchdog");
  });

  it("can be disabled without re-enabling the loose repeated-line heuristic", async () => {
    const runtime = makeRuntime(new LongReasoningCycleProvider(), {
      enabled: true,
      firstTokenMs: 100000,
      noProgressMs: 100000,
      maxCallMs: 100000,
      repetitionRepeats: 0,
      reasoningLoopLines: 0,
      reasoningCycleRepeats: 0,
    });
    const res = await runtime.runTurn("S", "go");
    expect(watchdogNotices("S")).toHaveLength(0);
    expect(res.assistantText).toBe("answer");
  });
});

/** Loops (reasoning cycle) on the FIRST call, then — once nudged — recovers on the retry. Mirrors
 *  the ctest q38-1 shape: the model oscillated keep-vs-revert, got stopped, and only needed to be
 *  told to decide and act. Records the messages each call received so the nudge can be asserted. */
class DeliberationLoopThenRecoverProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1;
    this.lastMessages = opts.messages;
    if (this.calls === 1) {
      const cycle = Array.from(
        { length: 72 },
        (_, i) => `state-slot-${String(i).padStart(3, "0")}: keep the audit test or revert it`,
      ).join("\n");
      for (let copy = 0; copy < 5; copy++) {
        for (let offset = 0; offset < cycle.length; offset += 41) {
          yield { type: "reasoning-delta", text: cycle.slice(offset, offset + 41) };
        }
      }
      yield { type: "text-delta", text: "answer" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield { type: "text-delta", text: "Decision made: keeping the test and moving on." };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Loops on EVERY call — the deadlock the nudge cannot break. Proves the retry is capped at one. */
class PersistentDeliberationLoopProvider implements Provider {
  calls = 0;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls += 1;
    const cycle = Array.from(
      { length: 72 },
      (_, i) => `state-slot-${String(i).padStart(3, "0")}: keep the audit test or revert it`,
    ).join("\n");
    for (let copy = 0; copy < 5; copy++) {
      for (let offset = 0; offset < cycle.length; offset += 41) {
        yield { type: "reasoning-delta", text: cycle.slice(offset, offset + 41) };
      }
    }
    yield { type: "text-delta", text: "answer" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

function retryNotices(sessionId: string) {
  return log
    .query(sessionId)
    .filter((e) => e.type === "notice")
    .filter((n) => (n.payload as { kind?: string }).kind === "stream_watchdog_retry");
}

describe("AgentRuntime reasoning-loop break-and-retry", () => {
  const cycleWatchdog: StreamWatchdogConfig = {
    enabled: true,
    firstTokenMs: 100000,
    noProgressMs: 100000,
    maxCallMs: 100000,
    repetitionRepeats: 12,
    reasoningLoopLines: 0,
    reasoningCycleRepeats: 3,
  };

  it("nudges a reasoning-cycle loop to decide and act, then retries once and recovers", async () => {
    const provider = new DeliberationLoopThenRecoverProvider();
    const runtime = makeRuntime(provider, cycleWatchdog);
    const res = await runtime.runTurn("S", "go");

    expect(provider.calls).toBe(2); // original + exactly one retry
    expect(res.assistantText).toBe("Decision made: keeping the test and moving on.");
    expect(res.stoppedReason).toBeUndefined(); // recovered — not a watchdog stop
    // The decisive nudge reached the retry call.
    const nudged = provider.lastMessages.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("repeated the same reasoning without taking action"),
    );
    expect(nudged).toBe(true);
    expect(retryNotices("S")).toHaveLength(1);
    // A recovered turn logs no terminal watchdog-stop notice.
    expect(watchdogNotices("S")).toHaveLength(0);
  });

  it("stops after a single loop-break retry when the model loops again", async () => {
    const provider = new PersistentDeliberationLoopProvider();
    const runtime = makeRuntime(provider, cycleWatchdog);
    const res = await runtime.runTurn("S", "go");

    expect(provider.calls).toBe(2); // one retry, then give up — never unbounded
    expect(res.stoppedReason).toBe("stream_watchdog");
    expect(res.assistantText).toContain("exact long reasoning cycle");
    expect(retryNotices("S")).toHaveLength(1); // nudged once
    expect(watchdogNotices("S")).toHaveLength(1); // one terminal stop notice
  });
});
