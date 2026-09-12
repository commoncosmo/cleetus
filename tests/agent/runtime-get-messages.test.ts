import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

class StubProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-getmsg-"));
  log = new EventLog(join(dir, "events.db"));
});

afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", new StubProvider());
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
    context: () => DEFAULT_CONTEXT,
  });
}

test("getMessages returns a copy of the session's in-memory history", () => {
  const runtime = makeRuntime();
  const msgs: Message[] = [
    { role: "user", content: "build a thing" },
    { role: "assistant", content: "1. step one\n2. step two" },
  ];
  runtime.loadSession("s1", msgs, []);
  const out = runtime.getMessages("s1");
  expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  out.push({ role: "user", content: "mutate" });
  expect(runtime.getMessages("s1")).toHaveLength(2); // returned a copy
});

test("getMessages on an unknown session returns []", () => {
  const runtime = makeRuntime();
  expect(runtime.getMessages("nope")).toEqual([]);
});
