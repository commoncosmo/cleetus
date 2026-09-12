import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ModelInfo, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

/** A provider that immediately answers and stops — no tools, no errors. */
class StopProvider implements Provider {
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-source-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
});
afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", new StopProvider());
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
    maxToolLoops: 5,
  });
}

test("a real user turn logs a user_input with no source", async () => {
  const runtime = makeRuntime();
  const s = sessions.create({ provider: "lm", model: "m" });
  await runtime.runTurn(s.id, "hello");
  const ui = log.query(s.id).find((e) => e.type === "user_input");
  expect((ui!.payload as { source?: string }).source).toBeUndefined();
});

test("a worker turn tags the user_input with its source (#142)", async () => {
  const runtime = makeRuntime();
  const s = sessions.create({ provider: "lm", model: "m" });
  await runtime.runTurn(s.id, "do task A", undefined, "orchestration-worker");
  const ui = log.query(s.id).find((e) => e.type === "user_input");
  expect((ui!.payload as { source?: string }).source).toBe("orchestration-worker");
});

test("a worker turn tags the user_input with its title (#152)", async () => {
  const runtime = makeRuntime();
  const s = sessions.create({ provider: "lm", model: "m" });
  await runtime.runTurn(s.id, "do task A", undefined, "orchestration-worker", "Verify API Routes");
  const ui = log.query(s.id).find((e) => e.type === "user_input");
  expect((ui!.payload as { title?: string }).title).toBe("Verify API Routes");
});

test("a real user turn has no title on its user_input (#152)", async () => {
  const runtime = makeRuntime();
  const s = sessions.create({ provider: "lm", model: "m" });
  await runtime.runTurn(s.id, "hello");
  const ui = log.query(s.id).find((e) => e.type === "user_input");
  expect((ui!.payload as { title?: string }).title).toBeUndefined();
});
