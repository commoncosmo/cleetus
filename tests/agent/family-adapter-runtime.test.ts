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
import type { ChatOptions, ModelInfo, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

const LEAKED =
  "<tool_call><function=read_file><parameter=path>a</parameter></function></tool_call>";

/** Call 1 leaks markup + reasoning and a recovered call; call 2 ends the turn normally. */
class RecoveringProvider implements Provider {
  calls: ChatOptions[] = [];
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls.push(opts);
    if (this.calls.length === 1) {
      yield { type: "text-delta", text: LEAKED };
      yield { type: "reasoning-delta", text: "thinking" };
      yield {
        type: "tool-call",
        call: { id: "r0", name: "read_file", args: { path: "a" } },
        recovered: true,
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

const readFile: Tool = {
  name: "read_file",
  description: "",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  serialize: () => "read_file",
  run: async (): Promise<ToolResult> => ({ ok: true, output: "file contents" }),
};

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-family-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
});
afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

test("recovered turn strips markup from stored content and keeps reasoning", async () => {
  const provider = new RecoveringProvider();
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(readFile);
  const runtime = new AgentRuntime({
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
  const s = sessions.create({ provider: "lm", model: "m" });
  await runtime.runTurn(s.id, "go");

  // The stored assistant tool-calls turn is replayed to the provider on the 2nd call.
  expect(provider.calls.length).toBe(2);
  const replayed = provider.calls[1]!.messages;
  const assistant = replayed.find((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0);
  expect(assistant).toBeDefined();
  expect(assistant!.content).not.toContain("<tool_call>");
  expect(assistant!.reasoning).toBe("thinking");
});
