import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIGEST_SYSTEM_PROMPT } from "../../src/agent/context/digest";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import { type ContextConfig, DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

/** Captures every chat() request's messages; replies with a fixed text turn. */
class CapturingProvider implements Provider {
  calls: Message[][] = [];
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls.push(opts.messages);
    yield { type: "text-delta", text: "SUMMARY: created files" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

/** Emits a `bash` tool call with a chunky narration for the first `limit` assistant turns,
 *  then finishes. Drives a long SINGLE live turn (one user message, many tool round-trips). */
class LoopingToolProvider implements Provider {
  calls: Message[][] = [];
  private n = 0;
  constructor(private readonly limit: number) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls.push(opts.messages);
    if (this.n++ < this.limit) {
      yield { type: "text-delta", text: "x".repeat(400) };
      yield {
        type: "tool-call",
        call: { id: `c${this.n}`, name: "bash", args: { command: "ls -la /tmp" } },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    }
  }
  async embed() {
    return [0];
  }
}

/** A minimal `bash`-like tool that returns chunky output so the live turn actually grows. */
const stubBash: Tool = {
  name: "bash",
  description: "",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  mutates: true,
  serialize: (args) => `bash: ${(args as { command?: string }).command ?? ""}`,
  run: async (): Promise<ToolResult> => ({ ok: true, output: "ok ".repeat(120) }),
};

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-ctx-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  overrides?: Partial<ContextConfig>,
  extraTools?: Tool[],
  maxToolLoops = 3,
  runtimeOverrides: Partial<AgentRuntimeOptions> = {},
): AgentRuntime {
  const context: ContextConfig = { ...DEFAULT_CONTEXT, ...overrides };
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  for (const t of extraTools ?? []) tools.register(t);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops,
    context: () => context,
    ...runtimeOverrides,
  });
}

describe("AgentRuntime context assembly", () => {
  it("fails locally before a provider call when fixed request overhead cannot fit the served window", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p, undefined, undefined, 3, {
      modelContextLength: () => 4096,
      systemPrompt: () => "system constraint ".repeat(1_000),
    });

    await expect(runtime.runTurn("S", "hello")).rejects.toThrow(
      /assembled request is still.*above the safe.*input limit/i,
    );
    expect(p.calls).toHaveLength(0);
    expect(
      log
        .query("S")
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "context_hard_trim",
        ),
    ).toBe(true);
  });

  it("sends full history (no notice) when it fits the budget", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p);
    await runtime.runTurn("S", "hello");
    const sent = p.calls.at(-1)!;
    expect(sent[0]).toEqual({ role: "system", content: "sys" });
    expect(sent.some((m) => m.role === "user" && m.content === "hello")).toBe(true);
    expect(log.query("S").filter((e) => e.type === "notice").length).toBe(0);
  });

  it("treats a zero detected context window as unknown instead of compacting continuously", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p, undefined, undefined, 3, {
      modelContextLength: () => 0,
    });

    await runtime.runTurn("S", "a".repeat(2_000));
    await runtime.runTurn("S", "b".repeat(2_000));
    await runtime.runTurn("S", "c".repeat(2_000));

    const events = log.query("S");
    expect(events.some((event) => event.type === "compaction_start")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "notice" &&
          /context window detected:.*= 0 tokens/i.test(
            (event.payload as { text?: string }).text ?? "",
          ),
      ),
    ).toBe(false);
    expect(p.calls.at(-1)?.some((message) => message.content.includes("a".repeat(2_000)))).toBe(
      true,
    );
  });

  it("on overflow: summarizes, sends [system, digest, live turn], keeps the user message, emits a notice", async () => {
    const p = new CapturingProvider();
    // budgetTokens must be above MIN_BUDGET (512) so the floor doesn't swallow the limit.
    // Use 600 and messages long enough to overflow it (~200 tokens each = ~800 chars).
    const longA = "a".repeat(820); // ceil(820/4)=205 tokens
    const longB = "b".repeat(820); // 205 tokens
    const longC = `third and final user instruction here please ${"c".repeat(780)}`; // ~207 tokens
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    await runtime.runTurn("S", longC);
    const sent = p.calls.at(-1)!;
    expect(sent[0]!.role).toBe("system");
    expect(sent.some((m) => m.content.includes("Earlier in this session"))).toBe(true);
    expect(sent.some((m) => m.content.includes("third and final user instruction"))).toBe(true);
    expect(
      log
        .query("S")
        .some((e) => e.type === "notice" && /trimmed/i.test((e.payload as { text: string }).text)),
    ).toBe(true);
  });

  it("on overflow: emits compaction_start/compaction_end with reason auto", async () => {
    const p = new CapturingProvider();
    const longA = "a".repeat(820);
    const longB = "b".repeat(820);
    const longC = `third and final user instruction here please ${"c".repeat(780)}`;
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    await runtime.runTurn("S", longC);
    const events = log.query("S");
    const start = events.find((e) => e.type === "compaction_start");
    expect(start).toBeDefined();
    expect((start!.payload as { reason: string }).reason).toBe("auto");
    expect(events.some((e) => e.type === "compaction_end")).toBe(true);
  });

  it("resets the digest on truncateHistory (rewind)", async () => {
    const p = new CapturingProvider();
    const longA = "a".repeat(820);
    const longB = "b".repeat(820);
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    runtime.truncateHistory("S", 0);
    p.calls.length = 0;
    await runtime.runTurn("S", "hi");
    expect(p.calls.at(-1)!.some((m) => m.content.includes("Earlier in this session"))).toBe(false);
  });

  it("with summarize off: drops the slice, sends no digest, notice says dropped", async () => {
    const p = new CapturingProvider();
    const longA = "a".repeat(820);
    const longB = "b".repeat(820);
    const longC = "c".repeat(820); // large live turn forces eviction of the older turns
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: false,
    });
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    await runtime.runTurn("S", longC);
    const sent = p.calls.at(-1)!;
    expect(sent.some((m) => m.content.includes("Earlier in this session"))).toBe(false);
    expect(
      log
        .query("S")
        .some((e) => e.type === "notice" && /dropped/i.test((e.payload as { text: string }).text)),
    ).toBe(true);
  });

  it("resets the digest on resetHistory (/clear)", async () => {
    const p = new CapturingProvider();
    const longA = "a".repeat(820);
    const longB = "b".repeat(820);
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    runtime.resetHistory("S");
    p.calls.length = 0;
    await runtime.runTurn("S", "hi");
    expect(p.calls.at(-1)!.some((m) => m.content.includes("Earlier in this session"))).toBe(false);
  });

  // The stable region is everything sent BEFORE the live turn's first user message: the
  // system prompt, the frozen digest, and the frozen tail of older turns.
  function stableRegion(sent: Message[], liveContent: string): Message[] {
    const liveIdx = sent.findIndex((m) => m.role === "user" && m.content === liveContent);
    return liveIdx >= 0 ? sent.slice(0, liveIdx) : sent;
  }

  it("boundary + digest are stable across two assemblies of the same saturated history", async () => {
    const p = new CapturingProvider();
    const longA = "a".repeat(820);
    const longB = "b".repeat(820);
    const longC = `third instruction here ${"c".repeat(800)}`;
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    // Saturate so a trim fires (the digest message appears in the prefix).
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    await runtime.runTurn("S", longC);
    const firstSent = p.calls.at(-1)!;
    expect(firstSent.some((m) => m.content.includes("Earlier in this session"))).toBe(true);
    // Capture the digest bytes and the full stable region (everything before the live turn).
    const firstDigest = firstSent.find((m) => m.content.includes("Earlier in this session"))!;
    const firstStable = stableRegion(firstSent, longC);

    // Re-assemble with a tiny new turn that does NOT re-cross the high-water mark. The
    // boundary is frozen and the digest is unchanged, so the previously-sent prefix
    // (system + digest + frozen tail) must appear byte-identical at the head of the new
    // request — an append-only, KV-cache-stable prompt prefix.
    p.calls.length = 0;
    await runtime.runTurn("S", "ok");
    const secondSent = p.calls.at(-1)!;
    // The first stable region is a byte-identical prefix of the second request.
    expect(secondSent.length).toBeGreaterThanOrEqual(firstStable.length);
    expect(secondSent.slice(0, firstStable.length)).toEqual(firstStable);
    // The digest message is byte-for-byte unchanged (not re-summarized into something else).
    const secondDigest = secondSent.find((m) => m.content.includes("Earlier in this session"))!;
    expect(secondDigest).toEqual(firstDigest);
  });

  it("no trim while the tail alone stays under budget*trimHighWater, trims once it exceeds it", async () => {
    // `budget` already nets out the system prompt, digest, and response reserve (computeBudget),
    // so it is the allowance for the history tail alone: the trigger compares the tail directly
    // against budget*trimHighWater with no overhead added back.
    // budget = floor(600*0.9) - 0 - estimateTokens("sys"=>1) - 0 = 540 - 1 = 539.
    // high = 539 * 0.85 ≈ 458 tokens. One ~205-token turn stays well under; three ~205-token
    // turns (~615 token tail) exceed it and trim.
    const long = () => "x".repeat(820); // ceil(820/4)=205 tokens

    // (a) Under the high-water mark: a single turn → no digest, no trim notice.
    const pUnder = new CapturingProvider();
    const under = makeRuntime(pUnder, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    await under.runTurn("S", long());
    const sentUnder = pUnder.calls.at(-1)!;
    expect(sentUnder.some((m) => m.content.includes("Earlier in this session"))).toBe(false);
    expect(
      log
        .query("S")
        .some((e) => e.type === "notice" && /trimmed/i.test((e.payload as { text: string }).text)),
    ).toBe(false);

    // (b) Once the tail alone exceeds the high-water mark, a trim fires.
    const pOver = new CapturingProvider();
    const over = makeRuntime(pOver, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    await over.runTurn("T", long());
    await over.runTurn("T", long());
    await over.runTurn("T", long());
    const sentOver = pOver.calls.at(-1)!;
    expect(sentOver.some((m) => m.content.includes("Earlier in this session"))).toBe(true);
    expect(
      log
        .query("T")
        .some((e) => e.type === "notice" && /trimmed/i.test((e.payload as { text: string }).text)),
    ).toBe(true);
  });

  // The capturing provider records summarizer calls too (they go through the same provider).
  // A summarizer call is a 2-message array whose system content is DIGEST_SYSTEM_PROMPT; the
  // user message is the rendered slice (renderSliceForSummary) of the folded messages.
  function summarizerRequests(p: CapturingProvider): Message[][] {
    return p.calls.filter((msgs) => msgs[0]?.content === DIGEST_SYSTEM_PROMPT);
  }

  it("a second trim folds ONLY the newly-frozen span, never re-folding from index 0", async () => {
    const p = new CapturingProvider();
    // budget = floor(600*0.9) - 1(sys) = 539; high ≈ 458 tokens. Each ~205-token turn that
    // pushes the tail past ~458 triggers a trim of the older span down to low-water (~296).
    const span = (marker: string) => `${marker} ${"z".repeat(800)}`; // ~201 tokens, marker visible
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    // First crossing: turns carrying ALPHA accumulate, then a later turn trips the high-water
    // mark and the ALPHA span is folded into the digest.
    await runtime.runTurn("S", span("ALPHA-one"));
    await runtime.runTurn("S", span("ALPHA-two"));
    await runtime.runTurn("S", span("ALPHA-three"));
    const afterFirst = summarizerRequests(p).length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Second crossing: turns carrying BRAVO accumulate past the (already-advanced) boundary
    // and a later turn trips the mark again, folding ONLY the BRAVO span.
    await runtime.runTurn("S", span("BRAVO-one"));
    await runtime.runTurn("S", span("BRAVO-two"));
    await runtime.runTurn("S", span("BRAVO-three"));
    const summarizers = summarizerRequests(p);
    expect(summarizers.length).toBeGreaterThan(afterFirst);

    // The FIRST summarizer folded the ALPHA span: its rendered slice mentions ALPHA, not BRAVO.
    const firstSlice = summarizers[0]![1]!.content;
    expect(firstSlice).toContain("ALPHA");
    expect(firstSlice).not.toContain("BRAVO");

    // The LAST summarizer folded only the newly-frozen span: BRAVO present, and the
    // already-folded earliest ALPHA turns absent — proof the second trim folded
    // [coveredThroughIndex, newBoundary) and never re-folded from index 0. (The boundary can now
    // advance INTO the previous live turn, so a trailing ALPHA turn that was the live message
    // during the first trim — and therefore not folded then — may legitimately appear here.)
    const lastSlice = summarizers.at(-1)![1]!.content;
    expect(lastSlice).toContain("BRAVO");
    expect(lastSlice).not.toContain("ALPHA-one");
    expect(lastSlice).not.toContain("ALPHA-two");
  });

  it("warns about large context at most once per session, re-arming after a trim", async () => {
    const p = new CapturingProvider();
    // Tiny warnTokens so a couple of turns cross it; budget chosen so those same turns do NOT
    // auto-trim (warn-once observed in isolation), yet a subsequent /compact still folds the
    // older messages (its recent reserve, budget*trimLowWater ≈ 605 tokens, sits just below the
    // accumulated history so the boundary advances) — which re-arms the warning.
    const runtime = makeRuntime(p, {
      budgetTokens: 1100,
      responseReserveTokens: 0,
      summarize: true,
      warnTokens: 300,
    });
    const turn = () => "w".repeat(820); // ~205 tokens
    const largeNotices = () =>
      log
        .query("W")
        .filter(
          (e) => e.type === "notice" && /Large context/.test((e.payload as { text: string }).text),
        ).length;

    // Two consecutive turns both exceed warnTokens but no trim occurs (well under high-water):
    // the warning fires exactly once.
    await runtime.runTurn("W", turn());
    await runtime.runTurn("W", turn());
    expect(largeNotices()).toBe(1);
    // No trim happened, so the flag is still set: a third over-threshold turn does not re-warn.
    await runtime.runTurn("W", turn());
    expect(largeNotices()).toBe(1);

    // Force a trim by compacting: this re-arms the warning (state.warned reset to false).
    await runtime.compactNow("W");
    // The next over-threshold turn warns again — exactly one additional notice.
    await runtime.runTurn("W", turn());
    expect(largeNotices()).toBe(2);
  });

  it("bounds a long single live turn and always keeps the originating user message", async () => {
    const p = new LoopingToolProvider(20);
    // Small budget so the live turn must fold; allow enough tool loops to overflow.
    const runtime = makeRuntime(
      p,
      { budgetTokens: 3000, responseReserveTokens: 0 },
      [stubBash],
      25,
    );
    await runtime.runTurn("S", "BUILD THE THING: a unique task marker");

    // Inspect the LAST assembled prompt sent to the provider.
    const last = p.calls.at(-1)!;
    const tokens = last.reduce((t, m) => t + Math.ceil((m.content ?? "").length / 4), 0);
    // Stays within a sane multiple of the budget (system + digest + reserve + tail), not 50k+.
    expect(tokens).toBeLessThan(8000);
    // The originating user message text is present exactly once.
    const taskHits = last.filter((m) => m.content?.includes("a unique task marker")).length;
    expect(taskHits).toBe(1);
    // A digest message was produced once folding kicked in.
    expect(last.some((m) => m.content?.startsWith("[Earlier in this session"))).toBe(true);
  });

  it("caps large live tool results and keeps the freshest one in the sent tail across compaction", async () => {
    const bigBash: Tool = {
      name: "bash",
      description: "",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      mutates: true,
      serialize: (a) => `bash: ${(a as { command?: string }).command ?? ""}`,
      run: async (): Promise<ToolResult> => ({ ok: true, output: "Z".repeat(40000) }),
    };
    const p = new LoopingToolProvider(4); // 4 tool round-trips in one live turn
    const runtime = makeRuntime(
      p,
      {
        budgetTokens: 4000,
        responseReserveTokens: 0,
        summarize: true,
        maxLiveToolResultChars: 8000,
      },
      [bigBash],
      6, // maxToolLoops > 4 so the turn runs to completion
    );
    await runtime.runTurn("S", "do the thing");

    const sent = p.calls.at(-1)!;
    const toolMsgs = sent.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBeGreaterThan(0);
    for (const t of toolMsgs) {
      expect(t.content.length).toBeLessThan(8200); // capped to the live cap + marker
      expect(t.content).toContain("request a narrower range");
    }
    // The 40000-char result was never summarized wholesale into the digest.
    const digest = sent.find((m) => m.content.includes("Earlier in this session"));
    if (digest) expect(digest.content).not.toContain("Z".repeat(50));

    // A compaction actually fired (otherwise the test proves nothing).
    expect(log.query("S").some((e) => e.type === "compaction_end")).toBe(true);
  });

  it("re-injects the todo list into the first user turn after a compaction", async () => {
    const p = new CapturingProvider();
    const longA = "a".repeat(820);
    const longB = "b".repeat(820);
    const longC = `third and final user instruction here please ${"c".repeat(780)}`;
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    // restoreTodos seeds latestTodosBySession without pushing a synthetic todo_write tool
    // result into history — a seeded tool message would become the permanent "freshest tool
    // result" (protectFreshestToolResult) and block the boundary from ever advancing, since
    // this scripted provider never issues a real tool call to supersede it.
    runtime.restoreTodos("S", [{ content: "wire the API", status: "in_progress" }]);
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    // This turn's assembly crosses the high-water mark and advances the boundary (see the
    // "on overflow" test above), arming the one-shot reinject flag.
    await runtime.runTurn("S", longC);
    // The NEXT user turn is the one that carries the reminder.
    await runtime.runTurn("S", "continue");

    const history = runtime.getMessages("S");
    const lastUser = [...history].reverse().find((m) => m.role === "user");
    expect(lastUser!.content).toContain(
      "Current working todo list (restored after history compaction):",
    );
    expect(lastUser!.content).toContain("wire the API");
  });

  it("re-injects the todo list after a manual /compact (compactNow) too", async () => {
    const p = new CapturingProvider();
    // Same budget shape as the auto-compaction test above, but stop at TWO long turns: the
    // tail (~420 tokens) stays under high-water (~458) so no auto-trim fires — compactNow is
    // the only boundary advance in this test (its low-water reserve ~296 < the tail, so it
    // folds; same layout as the "warns about large context" test).
    const runtime = makeRuntime(p, {
      budgetTokens: 600,
      responseReserveTokens: 0,
      summarize: true,
    });
    runtime.restoreTodos("M", [{ content: "wire the API", status: "in_progress" }]);
    await runtime.runTurn("M", "a".repeat(820));
    await runtime.runTurn("M", "b".repeat(820));
    const r = await runtime.compactNow("M");
    expect(r.compacted).toBe(true); // otherwise the test proves nothing

    await runtime.runTurn("M", "continue");
    const lastUser = [...runtime.getMessages("M")].reverse().find((m) => m.role === "user");
    expect(lastUser!.content).toContain(
      "Current working todo list (restored after history compaction):",
    );
    expect(lastUser!.content).toContain("wire the API");
  });

  it("a no-op compactNow does not arm the todo reminder", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p, { summarize: true });
    runtime.restoreTodos("N", [{ content: "wire the API", status: "in_progress" }]);
    await runtime.runTurn("N", "hi"); // tiny history: nothing trimmable
    const r = await runtime.compactNow("N");
    expect(r.compacted).toBe(false);

    await runtime.runTurn("N", "continue");
    const lastUser = [...runtime.getMessages("N")].reverse().find((m) => m.role === "user");
    expect(lastUser!.content).not.toContain("Current working todo list");
  });
});
