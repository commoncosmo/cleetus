import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool } from "../../src/tools/types";

class RecoveryProvider implements Provider {
  private call = 0;

  async listModels() {
    return [{ id: "m" }];
  }

  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.call++;
    if (this.call === 1) {
      for (let index = 0; index < 4; index++) {
        yield {
          type: "tool-call",
          call: { id: `call-${index}`, name: "attempt", args: { index } },
        };
      }
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "Recovered and completed." };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

class EmptyRetrievalProvider implements Provider {
  private call = 0;

  async listModels() {
    return [{ id: "m" }];
  }

  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.call++;
    if (this.call === 1) {
      for (let index = 0; index < 4; index++) {
        yield {
          type: "tool-call",
          call: { id: `fetch-${index}`, name: "web_fetch", args: { index } },
        };
      }
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "Forecast retrieved." };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

const attemptTool: Tool = {
  name: "attempt",
  description: "Fail the first two attempts, then succeed.",
  parameters: {
    type: "object",
    properties: { index: { type: "number" } },
    required: ["index"],
  },
  serialize: (args) => `attempt ${(args as { index: number }).index}`,
  async run(args) {
    const index = (args as { index: number }).index;
    return index < 2
      ? { ok: false, errorCode: "TOOL_FAILED", errorMessage: "not this approach" }
      : { ok: true, output: "worked" };
  },
};

const retrievalTool: Tool = {
  name: "web_fetch",
  description: "Fetch structured data.",
  parameters: {
    type: "object",
    properties: { index: { type: "number" } },
    required: ["index"],
  },
  serialize: (args) => `fetch ${(args as { index: number }).index}`,
  async run(args) {
    const index = (args as { index: number }).index;
    const body = index < 3 ? '{"generationtime_ms":1.2}' : '{"results":[{"id":1}]}';
    return {
      ok: true,
      output: `<untrusted-web-content url="https://api.example.test">${body}</untrusted-web-content>`,
    };
  },
};

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-learn-suggest-"));
  log = new EventLog(join(dir, "events.db"));
});

afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

test("suggests /learn after an interactive turn recovers from repeated real failures", async () => {
  const providers = new ProviderRegistry();
  providers.register("p", new RecoveryProvider());
  const tools = new ToolRegistry();
  tools.register(attemptTool);
  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "m" }),
    systemPrompt: () => "system",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 3,
    context: () => DEFAULT_CONTEXT,
    suggestLearnedPlaybook: true,
  });

  const result = await runtime.runTurn("s1", "find a working approach");

  expect(result.successfulToolCalls).toBe(2);
  expect(result.failedToolCalls).toBe(2);
  const suggestion = log
    .query("s1")
    .find(
      (event) =>
        event.type === "notice" &&
        (event.payload as { kind?: string }).kind === "learn_playbook_suggestion",
    );
  expect((suggestion?.payload as { text?: string }).text).toContain("/learn");
});

test("suggests /learn after repeated successful fetches return no application data", async () => {
  const providers = new ProviderRegistry();
  providers.register("p", new EmptyRetrievalProvider());
  const tools = new ToolRegistry();
  tools.register(retrievalTool);
  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "m" }),
    systemPrompt: () => "system",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 3,
    context: () => DEFAULT_CONTEXT,
    suggestLearnedPlaybook: true,
  });

  const result = await runtime.runTurn("s1", "Look up the current weather forecast");

  expect(result.failedToolCalls).toBe(0);
  expect(result.unproductiveToolCalls).toBe(3);
  const suggestion = log
    .query("s1")
    .find(
      (event) =>
        event.type === "notice" &&
        (event.payload as { kind?: string }).kind === "learn_playbook_suggestion",
    );
  expect((suggestion?.payload as { text?: string }).text).toContain("3 unsuccessful tool attempts");
});
