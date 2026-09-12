import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffortLevel } from "../../src/agent/effort";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

class RecordingProvider implements Provider {
  lastReq: ChatOptions | null = null;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncIterable<StreamEvent> {
    this.lastReq = opts;
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;
let providers: ProviderRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-effort-rt-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
  providers = new ProviderRegistry();
});
afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function runtimeFor(model: string, provider: RecordingProvider, effort: () => EffortLevel) {
  providers.register("lm", provider);
  return new AgentRuntime({
    providers,
    tools: new ToolRegistry(),
    dispatcher: new ToolDispatcher(new ToolRegistry()),
    log,
    router: staticRouter({ provider: "lm", model }),
    systemPrompt: () => "be terse",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 10,
    effort,
  });
}

describe("AgentRuntime effort dial", () => {
  it("sends reasoningEffort and a harmony line to a gpt-oss model", async () => {
    const provider = new RecordingProvider();
    const runtime = runtimeFor("gpt-oss-20b", provider, () => "high");
    const session = sessions.create({ provider: "lm", model: "gpt-oss-20b" });
    await runtime.runTurn(session.id, "hi");
    expect(provider.lastReq!.reasoningEffort).toBe("high");
    const sys = provider.lastReq!.messages.find((m) => m.role === "system")!;
    expect(sys.content).toContain("Reasoning: high");
  });

  it("sends reasoningEffort but no harmony line to a non-gpt-oss model", async () => {
    const provider = new RecordingProvider();
    const runtime = runtimeFor("llama-3.1-8b", provider, () => "low");
    const session = sessions.create({ provider: "lm", model: "llama-3.1-8b" });
    await runtime.runTurn(session.id, "hi");
    expect(provider.lastReq!.reasoningEffort).toBe("low");
    expect(provider.lastReq!.messages.some((m) => m.content.includes("Reasoning:"))).toBe(false);
  });
});
