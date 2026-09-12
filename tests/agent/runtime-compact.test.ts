import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { type ContextConfig, DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

/** chat() never yields; it only settles when the call's signal aborts (rejecting). Used to
 *  prove the summarizer timeout fires and routes into the extractive fallback. */
class HangingProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    await new Promise<void>((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    yield { type: "finish", reason: "stop" }; // unreachable
  }
  async embed() {
    return [0];
  }
}

/** Captures every chat() request's messages; replies with a fixed summary text. */
class CapturingProvider implements Provider {
  calls: Message[][] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls.push(opts.messages);
    yield { type: "text-delta", text: "SUMMARY: earlier work" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-compact-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  overrides?: Partial<ContextConfig>,
  modelContextLength?: number,
): AgentRuntime {
  const context: ContextConfig = { ...DEFAULT_CONTEXT, ...overrides };
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
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
    context: () => context,
    modelContextLength: modelContextLength !== undefined ? () => modelContextLength : undefined,
  });
}

/** Seed a multi-turn history ending in a live user message via the real loadSession seam. */
function seedHistory(runtime: AgentRuntime, sessionId: string): void {
  const long = (c: string) => c.repeat(820); // ~205 tokens each
  const messages: Message[] = [
    { role: "user", content: long("a") },
    { role: "assistant", content: long("b") },
    { role: "user", content: long("c") },
    { role: "assistant", content: long("d") },
    { role: "user", content: "third and final user instruction here please" },
  ];
  runtime.loadSession(sessionId, messages, []);
}

describe("AgentRuntime.compactNow", () => {
  it("folds history to the live turn and reports a token delta", async () => {
    const p = new CapturingProvider();
    // Small budget so the recent reserve does not already cover the seeded history; otherwise
    // /compact is a (correct) no-op because nothing exceeds the reserve.
    const runtime = makeRuntime(p, { summarize: true, budgetTokens: 600 });
    seedHistory(runtime, "S");

    const r = await runtime.compactNow("S");

    expect(r.compacted).toBe(true);
    expect(r.messagesFolded).toBeGreaterThan(0);
    expect(r.afterTokens).toBeLessThan(r.beforeTokens);
    expect(r.partial).toBe(false);
    // The summarizer was invoked (its system prompt differs from the operator one).
    expect(p.calls.length).toBeGreaterThan(0);
    // A notice was emitted.
    expect(
      log
        .query("S")
        .some((e) => e.type === "notice" && /trimmed/i.test((e.payload as { text: string }).text)),
    ).toBe(true);
  });

  it("is a no-op when nothing is trimmable", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p, { summarize: true });
    // A single user message: liveTurnStart === 0 === boundaryIndex.
    runtime.loadSession("S", [{ role: "user", content: "just one message" }], []);

    const r = await runtime.compactNow("S");

    expect(r.compacted).toBe(false);
    expect(r.messagesFolded).toBe(0);
    expect(r.beforeTokens).toBe(r.afterTokens);
    // No summarizer call.
    expect(p.calls.length).toBe(0);
  });

  it("threads an instruction into the summarizer", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p, { summarize: true, budgetTokens: 600 });
    seedHistory(runtime, "S");

    await runtime.compactNow("S", "the database migration");

    // The summarizer's user message carries the focus instruction.
    const summarizerCall = p.calls.find((msgs) =>
      msgs.some((m) => m.role === "user" && m.content.includes("Focus the summary on:")),
    );
    expect(summarizerCall).toBeDefined();
    expect(summarizerCall!.some((m) => m.content.includes("the database migration"))).toBe(true);
  });

  it("times out a hung summarizer and falls back to the extractive digest (no hang)", async () => {
    const runtime = makeRuntime(new HangingProvider(), {
      summaryTimeoutMs: 30,
      summarize: true,
      budgetTokens: 600,
    });
    // History with an edit tool call so the extractive fallback yields real content, ending in a
    // live user message that stays out of the trimmed slice.
    const long = (c: string) => c.repeat(820);
    runtime.loadSession(
      "T",
      [
        { role: "user", content: long("a") },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "write_file", args: { path: "/p/app.css" } }],
        },
        { role: "user", content: long("c") },
        { role: "assistant", content: long("d") },
        { role: "user", content: "final live instruction" },
      ],
      [],
    );
    const r = await runtime.compactNow("T");
    expect(r.compacted).toBe(true);
    expect(r.partial).toBe(true); // summarizer timed out → extractive fallback
  });

  it("emits compaction_start/compaction_end (reason manual) around a /compact", async () => {
    const runtime = makeRuntime(new CapturingProvider(), { summarize: true, budgetTokens: 600 });
    seedHistory(runtime, "T");
    await runtime.compactNow("T");
    const events = log.query("T");
    const start = events.find((e) => e.type === "compaction_start");
    const end = events.find((e) => e.type === "compaction_end");
    expect(start).toBeDefined();
    expect((start!.payload as { reason: string }).reason).toBe("manual");
    expect(end).toBeDefined();
    const ep = end!.payload as { outcome: string; messageCount: number; elapsedMs: number };
    expect(ep.outcome).toBe("summarized");
    expect(ep.messageCount).toBeGreaterThan(0);
    expect(ep.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("caps the compaction reserve at maxBudgetTokens on a large served window", async () => {
    // Served window is huge (256000). Without the cap the reserve would be 256000*0.55 and the
    // small seeded history would never fold. Capped at maxBudgetTokens=1000 → reserve 550 < the
    // ~832-token history, so it folds.
    const runtime = makeRuntime(
      new CapturingProvider(),
      { maxBudgetTokens: 1000, trimLowWater: 0.55 },
      256000,
    );
    seedHistory(runtime, "S");
    const r = await runtime.compactNow("S");
    expect(r.compacted).toBe(true);
  });

  it("with summarize off drops the slice instead of summarizing", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p, { summarize: false, budgetTokens: 600 });
    seedHistory(runtime, "S");

    const r = await runtime.compactNow("S");

    expect(r.compacted).toBe(true);
    expect(r.messagesFolded).toBeGreaterThan(0);
    expect(p.calls.length).toBe(0); // no summarizer call when dropping
    expect(
      log
        .query("S")
        .some((e) => e.type === "notice" && /dropped/i.test((e.payload as { text: string }).text)),
    ).toBe(true);
  });
});
