import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_SMART_CONFIG } from "../../src/config/routing";
import type { SmartConfig } from "../../src/config/types";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

const TIERS = {
  small: { provider: "lm", model: "small" },
  large: { provider: "lm", model: "large" },
};

const stubTool = (name: string): Tool => ({
  name,
  description: name,
  mutates: name !== "todo_write",
  parameters: { type: "object", properties: {} },
  serialize: () => name,
  run: async (): Promise<ToolResult> => ({ ok: true, output: "ok" }),
});

// Turn shape modeled on the r1 session trace: todo_write first, then several ordinary tool
// calls, then a final answer.
class PlannedBuildProvider implements Provider {
  seen: string[] = [];
  private calls = 0;

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: "tool-call",
        call: {
          id: "plan",
          name: "todo_write",
          args: { todos: [{ content: "scaffold", status: "pending" }] },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.calls <= 4) {
      yield { type: "tool-call", call: { id: `step-${this.calls}`, name: "bash", args: {} } };
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

// Never calls todo_write — exercises the call-count fallback instead.
class UnplannedBuildProvider implements Provider {
  seen: string[] = [];
  private calls = 0;

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    this.calls++;
    if (this.calls <= 4) {
      yield { type: "tool-call", call: { id: `step-${this.calls}`, name: "bash", args: {} } };
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
  dir = await mkdtemp(join(tmpdir(), "cleetus-broad-code-phase-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function buildRuntime(provider: Provider, smart: SmartConfig) {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(stubTool("todo_write"));
  tools.register(stubTool("bash"));
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: createRouter({
      getMode: () => "smart",
      getActive: () => TIERS.small,
      tiers: TIERS,
      smart,
    }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 8,
    modelContextLength: () => 131_072,
  });
}

describe("broad_code phase routing (runtime)", () => {
  it("drops to small right after the turn establishes a todo checklist", async () => {
    const provider = new PlannedBuildProvider();
    const runtime = buildRuntime(provider, DEFAULT_SMART_CONFIG);

    const result = await runtime.runTurn("S", "build a web app for the forecast");

    expect(result.assistantText).toBe("SMALL-DONE");
    expect(provider.seen).toEqual(["large", "small", "small", "small", "small"]);
  });

  it("drops to small once the plan-call cap is reached with no checklist ever established", async () => {
    const provider = new UnplannedBuildProvider();
    const runtime = buildRuntime(provider, { ...DEFAULT_SMART_CONFIG, broadCodePlanCalls: 2 });

    const result = await runtime.runTurn("S", "build a web app for the forecast");

    expect(result.assistantText).toBe("SMALL-DONE");
    expect(provider.seen).toEqual(["large", "large", "small", "small", "small"]);
  });
});
