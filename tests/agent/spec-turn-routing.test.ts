import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { buildSpecPlanPrompt, buildSpecRevisionPrompt } from "../../src/agent/spec-handoff";
import { DEFAULT_PLAN_MODE_GUARD } from "../../src/config/plan-mode";
import { DEFAULT_SMART_CONFIG } from "../../src/config/routing";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

const TIERS = {
  small: { provider: "lm", model: "small" },
  large: { provider: "lm", model: "large" },
};

class SpecProvider implements Provider {
  requests: ChatOptions[] = [];
  // A drafting/revision turn establishes a checklist, inspects, edits, and summarizes.
  actions: string[] = [];
  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }
  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    const action = this.actions.shift();
    if (action) {
      yield {
        type: "tool-call",
        call: {
          id: `call-${this.requests.length}`,
          name: action,
          args: { path: "docs/specs/chat.md", todos: [] },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "Draft ready for your review." };
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
  dir = await mkdtemp(join(tmpdir(), "cleetus-spec-routing-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(provider: SpecProvider, planMode = false) {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  for (const name of ["todo_write", "read_file", "edit_file"]) {
    tools.register({
      name,
      description: name,
      mutates: name === "edit_file",
      parameters: { type: "object", properties: {} },
      serialize: () => name,
      run: async () => ({
        ok: true,
        output: "ok",
        ...(name === "edit_file"
          ? { diff: { path: "docs/specs/chat.md", before: "# Draft", after: "# Revised draft" } }
          : {}),
      }),
    });
  }
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: createRouter({
      getMode: () => "smart",
      getActive: () => TIERS.small,
      tiers: TIERS,
      smart: { ...DEFAULT_SMART_CONFIG, broadCodePlanCalls: 1, deescalateAfterSuccesses: 2 },
    }),
    projectDir: dir,
    systemPrompt: () => "standard system",
    smallSystemPrompt: () => "small system",
    capability: () => "auto",
    modelContextLength: (model) => (model === "large" ? 131_072 : 8192),
    resolvePermission: async () => "allow",
    maxToolLoops: 8,
    planMode: () => planMode,
    planModeGuard: () => ({ ...DEFAULT_PLAN_MODE_GUARD, forcePlanAfterBlocks: 1 }),
  });
}

describe("spec workflow routing through the runtime", () => {
  it("holds large through framing answers, repeated revisions, and spec review, then releases", async () => {
    const provider = new SpecProvider();
    const runtime = makeRuntime(provider);
    const revision = buildSpecRevisionPrompt(
      "docs/specs/chat.md",
      "CORS is already configured on example.test. Auto-collapse the thinking pane when the answer starts.",
    );
    const prompts = [
      "/spec Add an Ollama chat page",
      "Use example.test:11434 and filter out embedding models.",
      revision,
      buildSpecRevisionPrompt("docs/specs/chat.md", "Keep thinking expanded until I collapse it."),
      buildSpecPlanPrompt("docs/specs/chat.md", "# Chat\nConnect to Ollama."),
    ];
    for (const prompt of prompts) {
      provider.actions = ["todo_write", "read_file", "edit_file"];
      const start = provider.requests.length;
      const result = await runtime.runTurn(
        "S",
        prompt,
        undefined,
        undefined,
        undefined,
        undefined,
        { specTurn: true },
      );
      expect(result.stoppedReason).toBeUndefined();
      expect(provider.requests.slice(start).map((req) => req.model)).toEqual([
        "large",
        "large",
        "large",
        "large",
      ]);
      // Auto capability must preview the same tier used for the actual call.
      expect(provider.requests[start]!.messages[0]!.content).toContain("standard system");
    }
    const specCalls = log.query("S").filter((event) => event.type === "model_call_start");
    expect(specCalls).toHaveLength(20);
    for (const event of specCalls) {
      expect(event.payload).toMatchObject({
        tier: "large",
        reason: "smart: escalated (spec_turn)",
      });
    }
    await runtime.runTurn("S", "Thanks");
    expect(provider.requests.at(-1)!.model).toBe("small");
  });

  it("retains spec routing when plan guards force tool-less synthesis", async () => {
    const provider = new SpecProvider();
    const runtime = makeRuntime(provider, true);
    provider.actions = ["edit_file"];
    const result = await runtime.runTurn(
      "S",
      buildSpecPlanPrompt("docs/specs/chat.md", "# Chat"),
      undefined,
      undefined,
      undefined,
      undefined,
      { specTurn: true },
    );
    expect(result.assistantText).toBe("Draft ready for your review.");
    expect(provider.requests.map((req) => req.model)).toEqual(["large", "large"]);
    const final = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .at(-1)!;
    expect((final.payload as { reason: string }).reason).toContain("plan-synthesis");
    expect((final.payload as { reason: string }).reason).toContain("spec_turn");
  });
});
