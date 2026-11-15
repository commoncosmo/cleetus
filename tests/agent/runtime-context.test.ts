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

const smallCompactingContext = {
  budgetTokens: 600,
  responseReserveTokens: 0,
  trimHighWater: 0.75,
  trimLowWater: 0.35,
};

describe("AgentRuntime context assembly", () => {
  for (const pages of [4, 8]) {
    it(`counts bounded MCP results for pressure and retention (${pages} pages)`, async () => {
      const requests: ChatOptions[] = [];
      let page = 0;
      const mcp: Tool = {
        name: "mcp__records__list",
        description: "schema ".repeat(2800),
        parameters: { type: "object", properties: {} },
        serialize: () => "list records",
        run: async () => ({
          ok: true,
          output: `HEAD-${page}\n${"Z".repeat(200000)}\nTAIL-${page}`,
        }),
      };
      const provider: Provider = {
        listModels: async () => [{ id: "m", contextLength: 131072 }],
        embed: async () => [0],
        async *chat(request) {
          if (request.messages[0]?.content === DIGEST_SYSTEM_PROMPT) {
            yield { type: "text-delta", text: "Earlier record pages inspected." };
            yield { type: "finish", reason: "stop" };
            return;
          }
          requests.push(request);
          if (page++ < pages) {
            yield { type: "tool-call", call: { id: `page-${page}`, name: mcp.name, args: {} } };
            yield { type: "finish", reason: "tool-calls" };
          } else {
            yield { type: "text-delta", text: "Records inspected." };
            yield { type: "finish", reason: "stop" };
          }
        },
      };
      const runtime = makeRuntime(provider, undefined, [mcp], pages + 2, {
        modelContextLength: () => 131072,
        systemPrompt: () => "sys ".repeat(3500),
      });
      await runtime.runTurn("MCP", "Inspect the record pages.");
      const compactions = log.query("MCP").filter((e) => e.type === "compaction_start");
      if (pages === 4) expect(compactions).toHaveLength(0);
      else expect(compactions.length).toBeGreaterThan(0);
      const sent = requests.at(-1)!.messages;
      // Retention must use bounded sizes too: keep several recent pages, not just one raw body.
      expect(sent.filter((m) => m.role === "tool").length).toBeGreaterThanOrEqual(3);
      expect(sent.some((m) => m.content.includes(`TAIL-${pages}`))).toBe(true);
      const raw = runtime.getMessages("MCP").filter((m) => m.role === "tool");
      expect(raw).toHaveLength(pages);
      expect(raw.every((m) => m.content.length > 200000)).toBe(true);
      const budget = runtime.getContextBudget("MCP")!;
      expect(budget).toMatchObject({
        provider: "lm",
        model: "m",
        contextLength: 131072,
        baseTokens: 32000,
      });
      expect(budget.assembledInputTokens).toBeLessThan(32000);
      budget.baseTokens = 1;
      expect(runtime.getContextBudget("MCP")!.baseTokens).toBe(32000);
      runtime.resetHistory("MCP");
      expect(runtime.getContextBudget("MCP")).toBeUndefined();
    });
  }

  it("keeps tooling moving under the ACP trace's unknown-window schema pressure", async () => {
    const requests: ChatOptions[] = [];
    let summaries = 0;
    const rounds = 24;
    const tool: Tool = {
      ...stubBash,
      description: "schema ".repeat(4160),
      run: async (args) => ({
        ok: true,
        output: `${(args as { command: string }).command}: ${"file contents ".repeat(55)}`,
      }),
    };
    const provider: Provider = {
      listModels: async () => [{ id: "m" }],
      embed: async () => [0],
      async *chat(request) {
        if (request.messages[0]?.content === DIGEST_SYSTEM_PROMPT) {
          summaries++;
          yield { type: "text-delta", text: "historical summary ".repeat(300) };
          yield { type: "finish", reason: "stop" };
          return;
        }
        requests.push(request);
        if (requests.length <= rounds) {
          yield {
            type: "tool-call",
            call: {
              id: `call-${requests.length}`,
              name: tool.name,
              args: { command: `read-${requests.length}` },
            },
          };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          yield { type: "text-delta", text: "Done." };
          yield { type: "finish", reason: "stop" };
        }
      },
    };
    const runtime = makeRuntime(provider, undefined, [tool], rounds + 2, {
      systemPrompt: () => "s".repeat(15_000),
    });
    const activeRequest = "Repair the site and verify the build.";
    await runtime.runTurn("S", activeRequest);
    const compactions = log.query("S").filter((event) => event.type === "compaction_end");
    expect(compactions.length).toBeGreaterThan(1);
    for (const event of compactions)
      expect(event.payload).toMatchObject({ strategy: "extractive" });
    expect(summaries).toBe(0);
    expect(requests).toHaveLength(rounds + 1);
    const sent = requests.at(-1)!.messages;
    expect(sent.filter((message) => message.content === activeRequest)).toHaveLength(1);
    expect(sent.filter((message) => message.role === "tool").length).toBeGreaterThan(1);
    expect(sent.at(-1)?.content).toStartWith(`read-${rounds}:`);
    expect(runtime.getMessages("S").filter((message) => message.role === "tool")).toHaveLength(
      rounds,
    );
    expect(runtime.getContextBudget("S")).toMatchObject({ baseTokens: 16384 });
    expect(runtime.getContextBudget("S")!.budgetTokens).toBeGreaterThan(1000);
  });

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

  it("on overflow: sends a local digest and the active request without a summarizer call", async () => {
    const p = new CapturingProvider();
    const longA = "a".repeat(820);
    const longB = "b".repeat(820);
    const longC = `third and final user instruction here please ${"c".repeat(780)}`;
    const runtime = makeRuntime(p, smallCompactingContext);
    await runtime.runTurn("S", longA);
    await runtime.runTurn("S", longB);
    await runtime.runTurn("S", longC);
    expect(p.calls).toHaveLength(3);
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
    const runtime = makeRuntime(p, smallCompactingContext);
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
    const longC = "c".repeat(820);
    const runtime = makeRuntime(p, { ...smallCompactingContext, summarize: false });
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
    const runtime = makeRuntime(p, smallCompactingContext);
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

  it("only counts older messages against the watermark after reserving the active request", async () => {
    const long = (marker: string) => `${marker} ${"x".repeat(820)}`;

    const provider = new CapturingProvider();
    const runtime = makeRuntime(provider, smallCompactingContext);
    await runtime.runTurn("S", long("first"));
    await runtime.runTurn("S", long("second"));
    // One earlier turn fits below the 384-token high-water mark. Counting the active
    // request again would push the second turn over it.
    expect(log.query("S").some((event) => event.type === "compaction_start")).toBe(false);
    expect(runtime.getContextBudget("S")?.tailTokens).toBeLessThan(250);

    await runtime.runTurn("S", long("third"));
    expect(log.query("S").some((event) => event.type === "compaction_start")).toBe(true);
    expect(provider.calls.at(-1)?.some((m) => m.content.includes("Earlier in this session"))).toBe(
      true,
    );
  });

  it("locally compacts a restored Air-sized transcript before its first model call", async () => {
    const p = new CapturingProvider();
    const runtime = makeRuntime(p, undefined, undefined, 3, { modelContextLength: () => 262144 });
    const historical: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "build", name: "run_tests", args: { check: "build" } }],
      },
      { role: "tool", toolCallId: "build", content: "src/main.ts: TS2307 missing import" },
      ...Array.from(
        { length: 1_350 },
        (_, i): Message => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Historical message ${i}: ${"x".repeat(1000)}`,
        }),
      ),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "recent", name: "read_file", args: { path: "package.json" } }],
      },
      { role: "tool", toolCallId: "recent", content: "Recent manifest contents" },
    ];
    runtime.loadSession("S", historical, []);
    const request = "Inspect package.json using the read-only commands.";
    await runtime.runTurn("S", request);
    await runtime.runTurn("S", "Thanks.");

    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]!.filter((message) => message.content === request)).toHaveLength(1);
    expect(p.calls[0]!.some((message) => message.content.includes("TS2307 missing import"))).toBe(
      true,
    );
    expect(
      p.calls[0]!.some((message) => message.content.startsWith("Historical message 1349:")),
    ).toBe(true);
    expect(runtime.getMessages("S").slice(0, historical.length)).toEqual(historical);
    const events = log.query("S");
    const compactions = events.filter((event) => event.type === "compaction_end");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]!.payload).toMatchObject({
      strategy: "extractive",
      outcome: "summarized",
    });
    expect((compactions[0]!.payload as { messageCount: number }).messageCount).toBeGreaterThan(
      1000,
    );
    expect(events.indexOf(compactions[0]!)).toBeLessThan(
      events.findIndex((event) => event.type === "model_call_start"),
    );
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
    const runtime = makeRuntime(p, smallCompactingContext);
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
