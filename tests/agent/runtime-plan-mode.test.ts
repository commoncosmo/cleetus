import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

// ---------------------------------------------------------------------------
// Shared test infrastructure (mirrors runtime-checkpoint.test.ts)
// ---------------------------------------------------------------------------

class ScriptedProvider implements Provider {
  lastMessages: ChatOptions["messages"] = [];
  constructor(private script: StreamEvent[][]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions) {
    this.lastMessages = opts.messages;
    const turn = this.script.shift();
    if (!turn) throw new Error("script empty");
    for (const e of turn) yield e;
  }
  async embed() {
    return [0];
  }
}

class FakeMutatingTool implements Tool {
  name = "fake_write";
  mutates = true;
  description = "writes";
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  ran = false;
  serialize() {
    return "fake_write";
  }
  async run(): Promise<ToolResult> {
    this.ran = true;
    return { ok: true, output: "wrote" };
  }
}

class FakeReadTool implements Tool {
  name = "fake_read";
  description = "reads";
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  ran = false;
  serialize() {
    return "fake_read";
  }
  async run(): Promise<ToolResult> {
    this.ran = true;
    return { ok: true, output: "read" };
  }
}

// ---------------------------------------------------------------------------
// Module-level setup
// ---------------------------------------------------------------------------

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;
let providers: ProviderRegistry;
let tools: ToolRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-rt-plan-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
  providers = new ProviderRegistry();
  tools = new ToolRegistry();
});

afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  scriptedProvider: Provider,
  opts: { planMode?: () => boolean; writeTool?: FakeMutatingTool; readTool?: FakeReadTool } = {},
) {
  providers.register("lm", scriptedProvider);
  if (opts.writeTool) tools.register(opts.writeTool);
  if (opts.readTool) tools.register(opts.readTool);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 10,
    planMode: opts.planMode,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runtime plan-mode gate", () => {
  it("denies a mutating tool in plan mode without running it", async () => {
    const tool = new FakeMutatingTool();
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "x.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "here is my plan" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { planMode: () => true, writeTool: tool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "make a change");
    expect(tool.ran).toBe(false);
    const events = log.query(session.id);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });

  it("runs a mutating tool normally when planMode is off", async () => {
    const tool = new FakeMutatingTool();
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "x.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { planMode: () => false, writeTool: tool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "make a change");
    expect(tool.ran).toBe(true);
  });

  it("in a mixed turn, blocks the mutating call but runs the read call", async () => {
    const writeTool = new FakeMutatingTool();
    const readTool = new FakeReadTool();
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "r1", name: "fake_read", args: { path: "x.ts" } } },
          { type: "tool-call", call: { id: "w1", name: "fake_write", args: { path: "x.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "plan after reading" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { planMode: () => true, writeTool, readTool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    // The turn completes without throwing, which means every pending call got a
    // matching tool result (pairing held despite the short-circuited mutating call).
    const res = await runtime.runTurn(session.id, "look then change");
    expect(readTool.ran).toBe(true);
    expect(writeTool.ran).toBe(false);
    expect(res.assistantText).toBe("plan after reading");
    const events = log.query(session.id);
    expect(events.some((e) => e.type === "notice")).toBe(true);
  });

  it("does not inject data-artifact retrieval guidance into a JSON-heavy plan review", async () => {
    const provider = new ScriptedProvider([
      [
        {
          type: "text-delta",
          text: "Plan:\n1. Define the JSON stream parser.\n2. Add tests and verification.",
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = makeRuntime(provider, { planMode: () => true });
    const session = sessions.create({ provider: "lm", model: "m" });

    await runtime.runTurn(
      session.id,
      "Review this JSON streaming specification and produce an implementation plan.",
    );

    const latestUser = [...provider.lastMessages]
      .reverse()
      .find((message) => message.role === "user");
    expect(latestUser?.content).toContain("PLAN MODE");
    expect(latestUser?.content).not.toContain("Data-artifact efficiency");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_efficiency_nudge",
        ),
    ).toBe(false);
  });
});
