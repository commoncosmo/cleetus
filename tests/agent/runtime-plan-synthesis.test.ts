import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { type ContextConfig, DEFAULT_CONTEXT } from "../../src/config/context";
import { DEFAULT_PLAN_MODE_GUARD } from "../../src/config/plan-mode";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

const stubBash: Tool = {
  name: "bash",
  description: "",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  mutates: true,
  serialize: () => "bash",
  run: async (): Promise<ToolResult> => ({ ok: true, output: "ok" }),
};

const stubInspect: Tool = {
  name: "inspect",
  description: "",
  parameters: { type: "object", properties: {} },
  mutates: false,
  serialize: () => "inspect",
  run: async (): Promise<ToolResult> => ({ ok: true, output: "useful repository evidence" }),
};

/** Main turns: "bash" → a blocked mutation, "inspect" → a successful allowed read, and any
 *  other string → a clean final answer. Tool-less synthesis calls emit `synthText`. */
class PlanModeProvider implements Provider {
  public mainCalls = 0;
  public synthCalls = 0;
  constructor(
    private readonly mainTurns: string[],
    private readonly synthText: string[],
  ) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    if (!req.tools || req.tools.length === 0) {
      const text = this.synthText[this.synthCalls++] ?? "";
      if (text) yield { type: "text-delta", text };
      yield { type: "finish", reason: "stop" };
      return;
    }
    const action = this.mainTurns[this.mainCalls] ?? "bash";
    this.mainCalls++;
    if (action === "bash") {
      yield {
        type: "tool-call",
        call: { id: `c${this.mainCalls}`, name: "bash", args: { command: "x" } },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else if (action === "inspect") {
      yield {
        type: "tool-call",
        call: { id: `c${this.mainCalls}`, name: "inspect", args: {} },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: action };
      yield { type: "finish", reason: "stop" };
    }
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-plansyn-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  maxToolLoops: number,
  forcePlanAfterBlocks: number,
): AgentRuntime {
  const context: ContextConfig = { ...DEFAULT_CONTEXT };
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(stubBash);
  tools.register(stubInspect);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops,
    context: () => context,
    planMode: () => true,
    planModeGuard: () => ({ ...DEFAULT_PLAN_MODE_GUARD, forcePlanAfterBlocks }),
  });
}

function notices(sessionId: string): string[] {
  return log
    .query(sessionId)
    .filter((e) => e.type === "notice")
    .map((e) => (e.payload as { text: string }).text);
}

describe("AgentRuntime plan-mode forced synthesis", () => {
  it("forces a plan after N blocked tool attempts, well before the loop cap", async () => {
    const provider = new PlanModeProvider([], ["Here is the plan: 1. scaffold 2. wire UI"]);
    const runtime = makeRuntime(provider, 50, 3);
    const res = await runtime.runTurn("S", "build it");
    expect(res.assistantText).toContain("Here is the plan");
    expect(provider.mainCalls).toBe(3); // stopped at the threshold, not 50
    expect(notices("S").some((t) => /producing a plan after 3 consecutive blocked/.test(t))).toBe(
      true,
    );
  });

  it("does not count scattered blocked mutations across successful read-only progress", async () => {
    const provider = new PlanModeProvider(
      ["bash", "inspect", "bash", "inspect", "bash", "Plan: 1. migrate the shell 2. verify it"],
      ["unused"],
    );
    const runtime = makeRuntime(provider, 50, 3);
    const res = await runtime.runTurn("S", "plan the migration");
    expect(res.assistantText).toContain("migrate the shell");
    expect(provider.mainCalls).toBe(6);
    expect(provider.synthCalls).toBe(0);
    expect(notices("S").some((text) => text.includes("producing a plan"))).toBe(false);
  });

  it("does not fire below the threshold (model gives a clean plan)", async () => {
    const provider = new PlanModeProvider(["bash", "Plan: do X then Y"], ["unused"]);
    const runtime = makeRuntime(provider, 50, 3);
    const res = await runtime.runTurn("S", "build it");
    expect(res.assistantText).toBe("Plan: do X then Y");
    expect(notices("S").some((t) => /producing a plan/.test(t))).toBe(false);
  });

  it("disabled (forcePlanAfterBlocks=0) runs to the cap, no synthesis", async () => {
    const provider = new PlanModeProvider([], []);
    const runtime = makeRuntime(provider, 5, 0);
    await runtime.runTurn("S", "build it");
    expect(provider.mainCalls).toBe(5); // hit the cap
    expect(notices("S").some((t) => /producing a plan/.test(t))).toBe(false);
  });

  it("empty synthesis result → honest fallback note", async () => {
    const provider = new PlanModeProvider([], []); // tool-less call yields no text
    const runtime = makeRuntime(provider, 50, 3);
    const res = await runtime.runTurn("S", "build it");
    expect(res.assistantText).toContain("Couldn't produce a plan");
    expect(provider.synthCalls).toBe(2);
  });

  it("retries once when the first tool-less synthesis is empty or tool-contaminated", async () => {
    const provider = new PlanModeProvider(
      [],
      ["", "Implementation plan:\n1. inspect the seam\n2. implement and verify it"],
    );
    const runtime = makeRuntime(provider, 50, 3);
    const res = await runtime.runTurn("S", "build it");
    expect(res.assistantText).toContain("Implementation plan");
    expect(provider.synthCalls).toBe(2);
    expect(notices("S").some((text) => text.includes("retrying tool-less"))).toBe(true);
  });
});
