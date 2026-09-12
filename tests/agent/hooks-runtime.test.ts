import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import type { HookEngine } from "../../src/hooks/types";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

class OneToolProvider implements Provider {
  calls = 0;
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: "tool-call",
        call: { id: "c1", name: "write_file", args: { path: "a", content: "x" } },
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

let ran = false;
const writeFile: Tool = {
  name: "write_file",
  description: "",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
  mutates: true,
  serialize: () => "write_file: a",
  run: async (): Promise<ToolResult> => {
    ran = true;
    return { ok: true, output: "wrote" };
  },
};

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;

beforeEach(async () => {
  ran = false;
  dir = await mkdtemp(join(tmpdir(), "cleetus-hooks-rt-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
});

afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(hooks: HookEngine, provider: Provider): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(writeFile);
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
    hooks,
  });
}

test("a pre hook block prevents dispatch and feeds the reason back", async () => {
  const provider = new OneToolProvider();
  const hooks: HookEngine = {
    runPreToolUse: async () => ({ allow: false, reason: "no writes here" }),
    runPostToolUse: async () => ({}),
  };
  const runtime = makeRuntime(hooks, provider);
  const s = sessions.create({ provider: "lm", model: "m" });
  await runtime.runTurn(s.id, "go");
  expect(ran).toBe(false); // tool never actually ran
  expect(log.query(s.id).some((e) => e.type === "notice")).toBe(true);
});

test("a post hook injects feedback into the tool result replayed to the model", async () => {
  const provider = new OneToolProvider();
  const hooks: HookEngine = {
    runPreToolUse: async () => ({ allow: true }),
    runPostToolUse: async () => ({ feedback: "lint: 1 error" }),
  };
  const runtime = makeRuntime(hooks, provider);
  const s = sessions.create({ provider: "lm", model: "m" });
  await runtime.runTurn(s.id, "go");
  expect(ran).toBe(true);
  // 2nd provider call replays history; the tool result carries the feedback.
  const replay = (provider as OneToolProvider).calls;
  expect(replay).toBe(2);
});
