import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import { CleetusError } from "../../src/lib/errors";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool } from "../../src/tools/types";

type Behavior =
  | { kind: "throw"; retryable: boolean; message: string }
  | { kind: "stop" }
  | { kind: "empty_markup" }
  | { kind: "empty_plain" };

/** A provider that follows a per-chat-call script: throw a CleetusError or stream a
 * normal stop, recording the ChatOptions it was called with for assertion. */
class FlakyProvider implements Provider {
  calls: ChatOptions[] = [];
  constructor(private behaviors: Behavior[]) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls.push(opts);
    const b = this.behaviors.shift() ?? { kind: "stop" };
    if (b.kind === "throw") {
      throw new CleetusError("PROVIDER_INVALID_RESPONSE", b.message, { retryable: b.retryable });
    }
    if (b.kind === "empty_markup") {
      // Tool call leaked into the reasoning channel; no text, no tool_calls → empty turn.
      yield {
        type: "reasoning-delta",
        text: 'I will call <tool_call>{"name":"glob","arguments":{}}</tool_call> now',
      };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (b.kind === "empty_plain") {
      yield { type: "reasoning-delta", text: "hmm, thinking about it" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield { type: "text-delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

const TOOL_PARSE = "chat request failed (500) error parsing tool call: invalid character '?'";
const GENERIC_500 = "chat request failed (500) internal server error";

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-retry-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
});
afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

/** Minimal registered tool so `toolCallEnvelope`'s name-enum is non-empty (WS4 constrained
 *  retries need at least one tool schema to build a meaningful envelope). */
const dummyTool: Tool = {
  name: "glob",
  description: "list files",
  parameters: { type: "object", properties: {} },
  serialize: () => "glob",
  run: async () => ({ ok: true, output: "" }),
};

function makeRuntime(provider: Provider, overrides?: Partial<AgentRuntimeOptions>): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(dummyTool);
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
    ...overrides,
  });
}

describe("AgentRuntime retry on retryable provider failure", () => {
  it("resamples once on a retryable error and recovers", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: true, message: TOOL_PARSE },
      { kind: "stop" },
    ]);
    const runtime = makeRuntime(provider);
    const s = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(s.id, "go");
    expect(result.assistantText).toBe("ok");
    expect(provider.calls.length).toBe(2);
    // a recovered turn surfaces no error to the user
    expect(log.query(s.id).some((e) => e.type === "error")).toBe(false);
  });

  it("appends a system nudge to the retry when the failure looks like a bad tool call", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: true, message: TOOL_PARSE },
      { kind: "stop" },
    ]);
    const runtime = makeRuntime(provider);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "go");
    const first = provider.calls[0]!.messages;
    const retry = provider.calls[1]!.messages;
    expect(retry.length).toBe(first.length + 1);
    const nudge = retry[retry.length - 1]!;
    expect(nudge.role).toBe("system");
    expect(nudge.content).toContain("invalid tool call");
  });

  it("retries without a nudge for a generic 5xx", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: true, message: GENERIC_500 },
      { kind: "stop" },
    ]);
    const runtime = makeRuntime(provider);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "go");
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[1]!.messages.length).toBe(provider.calls[0]!.messages.length);
  });

  it("ends the turn with a friendly notice when the retry also fails", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: true, message: TOOL_PARSE },
      { kind: "throw", retryable: true, message: TOOL_PARSE },
    ]);
    const runtime = makeRuntime(provider);
    const s = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(s.id, "go"); // must not throw
    expect(provider.calls.length).toBe(2); // initial + one resample, no more
    expect(result.assistantText).toContain("invalid tool call");
    const events = log.query(s.id);
    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    expect((notice!.payload as { text: string }).text).toContain("invalid tool call");
    // the technical error is still logged for diagnostics
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("still throws (no retry) on a non-retryable error", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: false, message: "chat request failed (400) bad" },
    ]);
    const runtime = makeRuntime(provider);
    const s = sessions.create({ provider: "lm", model: "m" });
    let threw = false;
    try {
      await runtime.runTurn(s.id, "go");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(provider.calls.length).toBe(1);
  });
});

const NO_THINKING = 'chat request failed (400) "m" does not support thinking';

describe('AgentRuntime retry on "does not support thinking" (#141)', () => {
  it("memoizes the model, strips reasoning_effort on the retry, and recovers with a notice", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: false, message: NO_THINKING },
      { kind: "stop" },
    ]);
    const runtime = makeRuntime(provider);
    const s = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(s.id, "go");
    expect(result.assistantText).toBe("ok");
    expect(provider.calls.length).toBe(2);
    // first call sent reasoning_effort (default medium); the retry stripped it
    expect(provider.calls[0]!.reasoningEffort).toBe("medium");
    expect(provider.calls[1]!.reasoningEffort).toBeUndefined();
    const notice = log.query(s.id).find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    expect((notice!.payload as { text: string }).text).toContain("doesn't support thinking");
  });

  it("does not retry the same model's no-thinking 400 twice (memo prevents a loop)", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: false, message: NO_THINKING },
      { kind: "throw", retryable: false, message: NO_THINKING },
    ]);
    const runtime = makeRuntime(provider);
    const s = sessions.create({ provider: "lm", model: "m" });
    let threw = false;
    try {
      await runtime.runTurn(s.id, "go");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(provider.calls.length).toBe(2); // initial + one resample, no infinite loop
  });
});

describe("AgentRuntime corrective empty-turn retry (WS3.2)", () => {
  it("appends a system nudge to the retry when the empty turn leaked tool-call markup into reasoning", async () => {
    const provider = new FlakyProvider([{ kind: "empty_markup" }, { kind: "stop" }]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn("s1", "hello");
    expect(provider.calls.length).toBe(2);
    const first = provider.calls[0]!.messages;
    const retry = provider.calls[1]!.messages;
    expect(retry.length).toBe(first.length + 1);
    const nudge = retry[retry.length - 1]!;
    expect(nudge.role).toBe("system");
    expect(nudge.content).toContain("reasoning channel");
  });

  it("keeps the blind retry (identical messages) for a pure-empty turn", async () => {
    const provider = new FlakyProvider([{ kind: "empty_plain" }, { kind: "stop" }]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn("s1", "hello");
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[1]!.messages.length).toBe(provider.calls[0]!.messages.length);
  });

  it("never persists the nudge to stored history", async () => {
    const provider = new FlakyProvider([{ kind: "empty_markup" }, { kind: "stop" }]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn("s1", "hello");
    const history = runtime.getMessages("s1");
    expect(
      history.some((m) => typeof m.content === "string" && m.content.includes("reasoning channel")),
    ).toBe(false);
  });
});

describe("AgentRuntime constrained corrective retries (WS4)", () => {
  it("the empty-markup retry carries the tool-call envelope and the nudge", async () => {
    const provider = new FlakyProvider([{ kind: "empty_markup" }, { kind: "stop" }]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn("s1", "hello");
    const retry = provider.calls[1]!;
    expect(retry.responseFormat?.kind).toBe("tool-call");
    const schema = retry.responseFormat!.schema as { properties: { name: { enum: string[] } } };
    expect(schema.properties.name.enum.length).toBeGreaterThan(0);
    expect(retry.messages[retry.messages.length - 1]!.content).toContain("reasoning channel");
  });

  it("a pure-empty retry stays unconstrained", async () => {
    const provider = new FlakyProvider([{ kind: "empty_plain" }, { kind: "stop" }]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn("s1", "hello");
    expect(provider.calls[1]!.responseFormat).toBeUndefined();
  });

  it("memoizes a response_format 400 and resamples unconstrained", async () => {
    const provider = new FlakyProvider([
      { kind: "empty_markup" },
      {
        kind: "throw",
        retryable: false,
        message: "chat request failed (400) unknown field: response_format",
      },
      { kind: "stop" },
    ]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn("s1", "hello");
    expect(provider.calls.length).toBe(3);
    expect(provider.calls[1]!.responseFormat).toBeDefined(); // the constrained attempt
    expect(provider.calls[2]!.responseFormat).toBeUndefined(); // memoized resample, nudge kept
    expect(provider.calls[2]!.messages[provider.calls[2]!.messages.length - 1]!.content).toContain(
      "reasoning channel",
    );
  });

  it('structured_output "off" never constrains', async () => {
    const provider = new FlakyProvider([{ kind: "empty_markup" }, { kind: "stop" }]);
    const runtime = makeRuntime(provider, { structuredOutput: () => "off" });
    await runtime.runTurn("s1", "hello");
    expect(provider.calls[1]!.responseFormat).toBeUndefined();
  });

  it("the 5xx tool-call-parse retry also carries the tool-call envelope", async () => {
    const provider = new FlakyProvider([
      { kind: "throw", retryable: true, message: TOOL_PARSE },
      { kind: "stop" },
    ]);
    const runtime = makeRuntime(provider);
    await runtime.runTurn("s1", "hello");
    expect(provider.calls[1]!.responseFormat?.kind).toBe("tool-call");
  });
});
