import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Router } from "../../src/agent/router";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type {
  ChatOptions,
  Message,
  ModelInfo,
  Provider,
  StreamEvent,
} from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ReadFileTool } from "../../src/tools/read-file";
import { ToolRegistry } from "../../src/tools/registry";

/** Emits read_file on the SAME path for `readSteps` consecutive steps, then stops. Captures the
 *  messages replayed on the final call so the test can inspect the tool-result history. */
class RepeatReadProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  constructor(
    private readonly path: string,
    private readonly readSteps: number,
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.lastMessages = opts.messages;
    if (this.calls <= this.readSteps) {
      yield {
        type: "tool-call",
        call: { id: `c${this.calls}`, name: "read_file", args: { path: this.path } },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    }
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

/** Reads the SAME path according to a per-chat-call script ("read" emits a read_file tool call;
 *  "stop" finishes). Lets a test span multiple runTurn() turns (each turn = read then stop). */
class ScriptedReadProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  constructor(
    private readonly path: string,
    private readonly script: ("read" | "stop")[],
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.lastMessages = opts.messages;
    const action = this.script[this.calls] ?? "stop";
    this.calls++;
    if (action === "read") {
      yield {
        type: "tool-call",
        call: { id: `c${this.calls}`, name: "read_file", args: { path: this.path } },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    }
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

/** Turn 1: read `targetPath` (routed to whichever pair is first in the router's sequence).
 *  Turn 2 (same runTurn's tool loop, since a "tool-calls" finish keeps looping): read an
 *  unrelated `otherPath` — exercises assembleMessages for a DIFFERENT routed pair without
 *  touching the target's cache entry. Turn 3: re-read `targetPath` unchanged. Turn 4: stop,
 *  capturing the replayed history that carries turn 3's (elided-or-not) tool result. */
class MixedPairReadProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  constructor(
    private readonly targetPath: string,
    private readonly otherPath: string,
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.lastMessages = opts.messages;
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: "tool-call",
        call: { id: "c1", name: "read_file", args: { path: this.targetPath } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.calls === 2) {
      yield {
        type: "tool-call",
        call: { id: "c2", name: "read_file", args: { path: this.otherPath } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.calls === 3) {
      yield {
        type: "tool-call",
        call: { id: "c3", name: "read_file", args: { path: this.targetPath } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-read-elide-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  ctxOverride?: Partial<typeof DEFAULT_CONTEXT>,
): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(new ReadFileTool());
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 5,
    context: () => ({ ...DEFAULT_CONTEXT, ...ctxOverride }),
  });
}

test("an unchanged in-window re-read is elided to a note in the replayed history (#153)", async () => {
  const path = join(dir, "f.ts");
  await writeFile(path, "FILEBODY_UNIQUE_TOKEN\nsecond line\n");
  const provider = new RepeatReadProvider(path, 2);
  const runtime = makeRuntime(provider);
  await runtime.runTurn("S", "read it twice");

  // On the final (stop) call the provider captured the full replayed history.
  const toolMsgs = provider.lastMessages.filter((m) => m.role === "tool");
  expect(toolMsgs.length).toBe(2);
  expect(toolMsgs[0]!.content).toContain("FILEBODY_UNIQUE_TOKEN"); // first read: full body
  expect(toolMsgs[1]!.content).not.toContain("FILEBODY_UNIQUE_TOKEN"); // second: elided
  expect(toolMsgs[1]!.content).toContain("unchanged");
});

test("a re-read of a file whose prior body was truncated below liveStart is re-sent, not elided (#153)", async () => {
  const path = join(dir, "big.ts");
  const TOKEN = "DEEP_TOKEN_PAST_CAP";
  // Body longer than the deep-history cap, with the unique token PAST the cap so that
  // slimDeepHistory drops it once the read falls below liveStart.
  await writeFile(path, `${"A".repeat(60)}\n${TOKEN}\nlast\n`);
  // Read once per turn, across two separate runTurn() turns (so the first read slips below
  // liveStart on the second turn) with a tiny deep-history cap so the first copy is truncated.
  const provider = new ScriptedReadProvider(path, ["read", "stop", "read", "stop"]);
  const runtime = makeRuntime(provider, { maxDeepToolResultChars: 50 });
  await runtime.runTurn("S", "read it (turn 1)");
  await runtime.runTurn("S", "read it again (turn 2)");

  // On turn 2's final replayed history the prior copy is truncated (token gone); the re-read
  // must therefore re-send the full body, so the token reappears in a tool result.
  const toolMsgs = provider.lastMessages.filter((m) => m.role === "tool");
  expect(toolMsgs.some((m) => (m.content ?? "").includes(TOKEN))).toBe(true);
});

test("a re-read that fit a LARGE routed pair's cap is re-sent (not elided) after a SMALL pair assembled in between", async () => {
  const targetPath = join(dir, "mixed.ts");
  const otherPath = join(dir, "other.ts");
  const TOKEN = "MIXED_PAIR_TOKEN";
  // ~3400 chars: comfortably ABOVE the small pair's live cap (~2412 chars, derived below from a
  // 4096-token window) and comfortably BELOW the large pair's live cap (clamped to the 6000-char
  // config ceiling — see below), with wide margins on both sides so the exact system-prompt/
  // tool-schema token estimate can't flip either comparison. Kept well clear of the small
  // pair's OWN trim high-water too, so this single-turn exchange never triggers real compaction
  // (which would call the provider again for summarization and desync the scripted call count).
  await writeFile(targetPath, `${TOKEN}\n${"B".repeat(3380)}\n`);
  await writeFile(otherPath, "unrelated file\n");

  const providers = new ProviderRegistry();
  const provider = new MixedPairReadProvider(targetPath, otherPath);
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(new ReadFileTool());

  // Routed-pair sequence for the three tool-loop iterations this turn takes: large, small,
  // large. Call 4 (the closing "stop") reuses "large-m"; its routing is irrelevant since it
  // makes no tool call.
  const sequence = ["large-m", "small-m", "large-m", "large-m"];
  let idx = 0;
  const router: Router = {
    select: () => {
      const model = sequence[Math.min(idx, sequence.length - 1)]!;
      idx++;
      return { choice: { provider: "lm", model }, tier: null, reason: "seq" };
    },
    finishPass: () => null,
  };

  // small-m: a 4096-token window yields (with the default reserves + this turn's tiny system
  // prompt/tool-schema/user-message tokens) a live cap of ~2412 chars — comfortably below the
  // body, and comfortably above the trim high-water needed so this turn's modest history never
  // triggers real compaction.
  // large-m: a 1,000,000-token window saturates maxBudgetTokens (96000, default), leaving a
  // budget far larger than needed to clamp liveCap at the config ceiling (maxLiveToolResultChars:
  // 6000) below.
  const modelContextLength = (m?: string): number | undefined => {
    if (m === "large-m") return 1_000_000;
    if (m === "small-m") return 4096;
    return undefined;
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
    context: () => ({ ...DEFAULT_CONTEXT, maxLiveToolResultChars: 6000 }),
  });

  await runtime.runTurn("S", "read target, then other, then target again");

  // Turn 3's re-read of targetPath (tool call id "c3") must be re-sent in full: the
  // session-minimum live cap (stamped small by turn 2's small-m assembly) is smaller than the
  // body, so the recorded copy no longer "fits" and must not be elided — even though turn 3
  // itself routed to the large pair, whose OWN cap the body does fit. Anchor on the specific
  // tool-call id (rather than "any tool message contains TOKEN") since turn 1's own read of the
  // same path always carries the token in full and would trivially satisfy a looser assertion.
  const rereadMsg = provider.lastMessages.find((m) => m.role === "tool" && m.toolCallId === "c3");
  expect(rereadMsg).toBeDefined();
  expect(rereadMsg!.content).toContain(TOKEN);
});
