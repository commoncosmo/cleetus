import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_SMART_CONFIG } from "../../src/config/routing";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import { RequestEscalationTool } from "../../src/tools/request-escalation";

const TIERS = {
  small: { provider: "lm", model: "small" },
  large: { provider: "lm", model: "large" },
};

// First call (small) requests escalation via the tool; the following call (whichever tier the
// router hands it) answers directly, tagged with its own model name.
class EscalationRequestProvider implements Provider {
  seen: string[] = [];
  requests: ChatOptions[] = [];

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    this.requests.push(req);
    if (this.seen.length === 1) {
      yield {
        type: "tool-call",
        call: {
          id: "esc-1",
          name: "request_escalation",
          args: { reason: "this needs careful multi-file reasoning" },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: `${req.model.toUpperCase()}-DONE` };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-escalation-request-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function buildRuntime(mode: "manual" | "smart", provider: Provider) {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(new RequestEscalationTool());
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: createRouter({
      getMode: () => mode,
      getActive: () => TIERS.small,
      tiers: TIERS,
      smart: DEFAULT_SMART_CONFIG,
    }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 8,
    modelContextLength: () => 131_072,
  });
}

describe("request_escalation tool visibility", () => {
  it("is advertised in smart mode with tiers configured", async () => {
    const provider = new EscalationRequestProvider();
    const runtime = buildRuntime("smart", provider);
    await runtime.runTurn("S", "fix this");
    const names = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("request_escalation");
  });

  it("is hidden in manual mode", async () => {
    const provider = new EscalationRequestProvider();
    const runtime = buildRuntime("manual", provider);
    await runtime.runTurn("S", "fix this");
    const names = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).not.toContain("request_escalation");
  });
});

describe("request_escalation routing effect", () => {
  it("escalates to large on the call after the small tier requests it", async () => {
    const provider = new EscalationRequestProvider();
    const runtime = buildRuntime("smart", provider);
    const result = await runtime.runTurn("S", "fix this");

    expect(result.assistantText).toBe("LARGE-DONE");
    expect(provider.seen).toEqual(["small", "large"]);
    const starts = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .map((event) => event.payload as { tier?: string; reason?: string });
    expect(starts[1]?.reason).toContain("model_requested");
  });
});
