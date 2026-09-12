import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { type ContextConfig, DEFAULT_CONTEXT } from "../../src/config/context";
import type { SmartConfig } from "../../src/config/types";
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
  serialize: (args) => `bash: ${(args as { command?: string }).command ?? ""}`,
  run: async (): Promise<ToolResult> => ({ ok: true, output: "ok" }),
};

// Records the model of every chat call so a test can assert whether the large tier ran.
// The small tier optionally makes one tool call on its first pass; the large tier (finish
// pass) emits a distinct synthesis string.
class TieredProvider implements Provider {
  seen: string[] = [];
  constructor(private readonly smallUsesTool: boolean) {}
  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }
  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    if (req.model === "large") {
      yield { type: "text-delta", text: "LARGE-SYNTHESIS" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    const smallCalls = this.seen.filter((m) => m === "small").length;
    if (this.smallUsesTool && smallCalls === 1) {
      yield { type: "tool-call", call: { id: "c1", name: "bash", args: { command: "echo hi" } } };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "SMALL-ANSWER" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

const smart: SmartConfig = {
  escalateAfterFailures: 99,
  deescalateAfterSuccesses: 2,
  broadCodePlanCalls: 5,
  contextWindowPercent: 100,
  escalateOnCodeEdit: "never",
  keywords: [],
};

function speedRuntime(provider: Provider, log: EventLog, dir: string): AgentRuntime {
  const context: ContextConfig = { ...DEFAULT_CONTEXT };
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(stubBash);
  const router = createRouter({
    getMode: () => "speed",
    getActive: () => ({ provider: "lm", model: "small" }),
    tiers: { small: { provider: "lm", model: "small" }, large: { provider: "lm", model: "large" } },
    smart,
  });
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router,
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 4,
    context: () => context,
  });
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-finish-gate-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

describe("speed finish pass is gated on tool use", () => {
  it("no tools this turn → small's answer is final, large never runs", async () => {
    const provider = new TieredProvider(false);
    const runtime = speedRuntime(provider, log, dir);
    const res = await runtime.runTurn("S", "hello");
    expect(res.assistantText).toBe("SMALL-ANSWER");
    expect(provider.seen).not.toContain("large");
  });

  it("tool used this turn → large finish synthesis runs and replaces the answer", async () => {
    const provider = new TieredProvider(true);
    const runtime = speedRuntime(provider, log, dir);
    const res = await runtime.runTurn("S", "do a thing");
    expect(res.assistantText).toBe("LARGE-SYNTHESIS");
    expect(provider.seen).toContain("large");
  });
});

class ProgressRoutingProvider implements Provider {
  seen: string[] = [];
  requests: ChatOptions[] = [];
  private calls = 0;

  constructor(
    private readonly toolRounds: number,
    private readonly toolCall: { name: string; args: unknown } = {
      name: "bash",
      args: { command: "check" },
    },
  ) {}

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    this.requests.push(req);
    if (req.model === "large") {
      yield { type: "text-delta", text: "LARGE-RECOVERY" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    this.calls++;
    if (this.calls <= this.toolRounds) {
      yield {
        type: "tool-call",
        call: { id: `progress-${this.calls}`, ...this.toolCall },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "SMALL-DONE" };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

class IdentifierResolutionRoutingProvider implements Provider {
  seen: string[] = [];
  private calls = 0;

  constructor(
    private readonly searchAgain = false,
    private readonly interveneBeforeResolution = false,
  ) {}

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    this.calls++;
    const coordinates = "42.082493,-87.750229";
    const resolutionCall = {
      id: "resolve-coordinates",
      name: "web_search",
      args: { query: "Wilmette Illinois coordinates" },
    };
    const call =
      this.calls === 1
        ? { id: "source", name: "web_search", args: { query: "weather API" } }
        : this.calls === 2
          ? {
              id: "unguarded-coordinates",
              name: "web_fetch",
              args: { url: `https://api.example.test/forecast/${coordinates}` },
            }
          : this.interveneBeforeResolution && this.calls === 3
            ? {
                id: "intervening-docs",
                name: "web_fetch",
                args: { url: "https://docs.example.test/weather" },
              }
            : this.calls === (this.interveneBeforeResolution ? 4 : 3)
              ? resolutionCall
              : !this.interveneBeforeResolution && this.calls === 4
                ? this.searchAgain
                  ? {
                      id: "search-again",
                      name: "web_search",
                      args: { query: "another forecast source" },
                    }
                  : {
                      id: "grounded-forecast",
                      name: "web_fetch",
                      args: { url: `https://api.example.test/forecast/${coordinates}` },
                    }
                : null;
    if (call) {
      yield { type: "tool-call", call };
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

class SourceLeaseRoutingProvider implements Provider {
  seen: string[] = [];

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    if (this.seen.length === 1) {
      yield {
        type: "tool-call",
        call: {
          id: "source-edit",
          name: "write_file",
          args: { path: "src/app.ts", content: "export {};" },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.seen.length === 2) {
      yield {
        type: "tool-call",
        call: { id: "verify", name: "bash", args: { command: "bun test" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: `${req.model.toUpperCase()}-FINAL` };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

// Like SourceLeaseRoutingProvider, but the large tier's first call (after a failed-verification
// escalation) writes a further fix edit to the same file instead of finishing directly — bumping
// the edit epoch again before any new verification runs.
class VerifyFailThenFixEditRoutingProvider implements Provider {
  seen: string[] = [];

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    if (this.seen.length === 1) {
      yield {
        type: "tool-call",
        call: {
          id: "source-edit",
          name: "write_file",
          args: { path: "src/app.ts", content: "export {};" },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.seen.length === 2) {
      yield {
        type: "tool-call",
        call: { id: "verify", name: "bash", args: { command: "bun test" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.seen.length === 3) {
      yield {
        type: "tool-call",
        call: {
          id: "fix-edit",
          name: "write_file",
          args: { path: "src/app.ts", content: "export const x = 1;" },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: `${req.model.toUpperCase()}-FINAL` };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

class FailureLeaseRoutingProvider implements Provider {
  seen: string[] = [];

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    if (this.seen.length <= 4) {
      yield {
        type: "tool-call",
        call: { id: `recovery-${this.seen.length}`, name: "bash", args: { command: "check" } },
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

// Two successful tool calls first (building a pre-existing success streak), then a reasoned-empty
// small completion that grants a recovery lease, then two successful tool calls on large across
// two separate iterations the lease continues to hold. Exercises both the original Finding 1 bug
// (without resetting the success counter at grant time, the pre-existing streak (2) plus the
// first post-grant success (making 3) would already clear the default deescalateAfterSuccesses
// threshold (2) on the very next call) and the follow-up bug in the literal per-iteration reset
// (resetting the counter on every held iteration — not only the actual grant — would wipe the
// streak before the second post-grant success is ever recorded, so the lease could never reach a
// threshold above 1 no matter how many further tool calls succeed).
class RecoveryLeaseGrantResetProvider implements Provider {
  seen: string[] = [];
  private calls = 0;

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    this.calls++;
    if (this.calls <= 2) {
      yield {
        type: "tool-call",
        call: { id: `pre-${this.calls}`, name: "bash", args: { command: "check" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.calls === 3) {
      yield { type: "reasoning-delta", text: "I considered the task but failed to answer." };
      yield { type: "finish", reason: "stop" };
      return;
    }
    if (this.calls === 4 || this.calls === 5) {
      yield {
        type: "tool-call",
        call: { id: `post-grant-${this.calls}`, name: "bash", args: { command: "verify" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "SMALL-RELEASED" };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

// Escalates via three consecutive tool failures, earns two consecutive successes on large across
// two separate held iterations to actually release the lease back to small (deescalateAfterSuccesses
// = 2, exercising the real multi-success-before-release scenario rather than the degenerate
// threshold-1 case), then hits one more tool failure right on the release call itself. Exercises
// the bug in Finding 2: without actually clearing routingRecoveryLeaseActive on release, that one
// failure alone (well under the real escalate_after_failures threshold of 3) would resurrect
// recovery_in_progress immediately on the very next call. Also exercises the fixed grant-only
// reset: with the earlier per-iteration reset bug, the second success would never be counted (see
// RecoveryLeaseGrantResetProvider above), so the lease would never release here at all.
class LeaseReleaseRegressionProvider implements Provider {
  seen: string[] = [];
  private calls = 0;

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    this.calls++;
    if (this.calls <= 3) {
      yield {
        type: "tool-call",
        call: { id: `fail-${this.calls}`, name: "bash", args: { command: "check" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.calls === 4 || this.calls === 5) {
      yield {
        type: "tool-call",
        call: { id: `recover-${this.calls}`, name: "bash", args: { command: "verify" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.calls === 6) {
      yield {
        type: "tool-call",
        call: { id: "post-release-fail", name: "bash", args: { command: "check-again" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "SMALL-STABLE" };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

class ReasonedEmptyRoutingProvider implements Provider {
  seen: ChatOptions[] = [];

  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }

  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req);
    if (req.model === "small") {
      yield { type: "reasoning-delta", text: "I considered the task but failed to answer." };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield { type: "text-delta", text: "LARGE-RECOVERY" };
    yield { type: "finish", reason: "stop" };
  }

  async embed() {
    return [0];
  }
}

function smartRuntime(
  provider: Provider,
  tool: Tool | Tool[],
  contextWindowPercent = 100,
  escalateOnCodeEdit: SmartConfig["escalateOnCodeEdit"] = "never",
  deescalateAfterSuccesses = 2,
): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  for (const item of Array.isArray(tool) ? tool : [tool]) tools.register(item);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: createRouter({
      getMode: () => "smart",
      getActive: () => ({ provider: "lm", model: "small" }),
      tiers: {
        small: { provider: "lm", model: "small" },
        large: { provider: "lm", model: "large" },
      },
      smart: {
        ...smart,
        escalateAfterFailures: 3,
        deescalateAfterSuccesses,
        contextWindowPercent,
        escalateOnCodeEdit,
      },
    }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 8,
    context: () => ({ ...DEFAULT_CONTEXT }),
    modelContextLength: () => 131_072,
  });
}

describe("smart routing uses tool outcomes rather than loop depth", () => {
  it("recovers a reasoned-empty small completion with the large tier", async () => {
    const provider = new ReasonedEmptyRoutingProvider();
    const runtime = smartRuntime(provider, stubBash);

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("LARGE-RECOVERY");
    expect(provider.seen.map((request) => request.model)).toEqual(["small", "large"]);
    expect(provider.seen[1]!.messages.at(-1)!.content).toContain(
      "completed its reasoning without producing an answer",
    );
    const recovery = log
      .query("S")
      .find((event) => (event.payload as { kind?: string }).kind === "route_recovery");
    expect(recovery).toBeDefined();
  });

  it("reselects the large tier when assembled input exceeds its configured capacity share", async () => {
    const provider = new ProgressRoutingProvider(0);
    const runtime = smartRuntime(provider, stubBash, 0.01);

    const result = await runtime.runTurn("S", "summarize the project");

    expect(result.assistantText).toBe("LARGE-RECOVERY");
    expect(provider.seen).toEqual(["large"]);
  });

  it("keeps successful multi-step tool work on the small tier", async () => {
    const provider = new ProgressRoutingProvider(5);
    const runtime = smartRuntime(provider, {
      ...stubBash,
      run: async () => ({ ok: true, output: "ok" }),
    });

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("SMALL-DONE");
    expect(provider.seen).not.toContain("large");
  });

  it("escalates retrieval after the small tier returns to broad discovery", async () => {
    const provider = new ProgressRoutingProvider(3, {
      name: "web_search",
      args: { query: "current forecast" },
    });
    const webSearch: Tool = {
      name: "web_search",
      description: "search",
      parameters: { type: "object", properties: {} },
      mutates: false,
      serialize: () => "web_search current forecast",
      run: async () => ({
        ok: true,
        output: "1. Current authoritative source — https://example.test/forecast",
      }),
    };
    const runtime = smartRuntime(provider, webSearch);

    const result = await runtime.runTurn("S", "look up the current weather");

    expect(result.assistantText).toBe("LARGE-RECOVERY");
    expect(provider.seen).toEqual(["small", "small", "large"]);
    expect(
      provider.requests
        .at(-1)!
        .messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("current authoritative machine-readable endpoint"),
        ),
    ).toBe(true);
    expect(
      log
        .query("S")
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_stalled",
        ),
    ).toBe(true);
  });

  it("keeps one provenance-resolution search on the small tier", async () => {
    const coordinates = "42.082493,-87.750229";
    const search: Tool = {
      name: "web_search",
      description: "search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      mutates: false,
      serialize: () => "web_search",
      run: async (args) => ({
        ok: true,
        output: (args as { query: string }).query.includes("coordinates")
          ? `Wilmette coordinates: ${coordinates}`
          : "Open-Meteo — https://open-meteo.com/",
      }),
    };
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      mutates: false,
      serialize: () => "web_fetch",
      run: async () => ({ ok: true, output: "current forecast" }),
    };
    const provider = new IdentifierResolutionRoutingProvider();
    const runtime = smartRuntime(provider, [search, fetch]);

    const result = await runtime.runTurn("S", "look up the current weather in Wilmette, Illinois");

    expect(result.assistantText).toBe("SMALL-DONE");
    expect(provider.seen).toEqual(["small", "small", "small", "small", "small"]);
    expect(
      log
        .query("S")
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_identifier_resolution",
        ),
    ).toBe(true);
    expect(
      log
        .query("S")
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_stalled",
        ),
    ).toBe(false);
  });

  it("spends the provenance-resolution exemption only once", async () => {
    const search: Tool = {
      name: "web_search",
      description: "search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      mutates: false,
      serialize: () => "web_search",
      run: async (args) => ({
        ok: true,
        output: (args as { query: string }).query.includes("coordinates")
          ? "Wilmette coordinates: 42.082493,-87.750229"
          : "Open-Meteo — https://open-meteo.com/",
      }),
    };
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      mutates: false,
      serialize: () => "web_fetch",
      run: async () => ({ ok: true, output: "current forecast" }),
    };
    const provider = new IdentifierResolutionRoutingProvider(true);
    const runtime = smartRuntime(provider, [search, fetch]);

    const result = await runtime.runTurn("S", "look up the current weather in Wilmette, Illinois");

    expect(result.assistantText).toBe("LARGE-DONE");
    expect(provider.seen).toEqual(["small", "small", "small", "small", "large"]);
    expect(
      log
        .query("S")
        .filter(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_identifier_resolution",
        ),
    ).toHaveLength(1);
    expect(
      log
        .query("S")
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_stalled",
        ),
    ).toBe(true);
  });

  it("expires the provenance-resolution exemption after intervening tool work", async () => {
    const search: Tool = {
      name: "web_search",
      description: "search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      mutates: false,
      serialize: () => "web_search",
      run: async (args) => ({
        ok: true,
        output: (args as { query: string }).query.includes("coordinates")
          ? "Wilmette coordinates: 42.082493,-87.750229"
          : "Open-Meteo — https://open-meteo.com/",
      }),
    };
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      mutates: false,
      serialize: () => "web_fetch",
      run: async () => ({ ok: true, output: "documentation" }),
    };
    const provider = new IdentifierResolutionRoutingProvider(false, true);
    const runtime = smartRuntime(provider, [search, fetch]);

    const result = await runtime.runTurn("S", "look up the current weather in Wilmette, Illinois");

    expect(result.assistantText).toBe("LARGE-DONE");
    expect(provider.seen).toEqual(["small", "small", "small", "small", "large"]);
    expect(
      log
        .query("S")
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_identifier_resolution",
        ),
    ).toBe(false);
    expect(
      log
        .query("S")
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_stalled",
        ),
    ).toBe(true);
  });

  it("routes on compacted input pressure rather than a large raw tool result", async () => {
    const provider = new ProgressRoutingProvider(2);
    const runtime = smartRuntime(provider, {
      ...stubBash,
      run: async () => ({ ok: true, output: "x".repeat(50_000) }),
    });

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("SMALL-DONE");
    expect(provider.seen).not.toContain("large");
  });

  it("keeps a JSON artifact write on the small tier", async () => {
    const provider = new ProgressRoutingProvider(1, {
      name: "write_file",
      args: { path: "forecast.json", content: "{}" },
    });
    const writeArtifact: Tool = {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: {} },
      mutates: true,
      serialize: () => "write forecast.json",
      run: async () => ({
        ok: true,
        output: "wrote forecast.json",
        diff: { path: join(dir, "forecast.json"), before: "", after: "{}", created: true },
      }),
    };
    const runtime = smartRuntime(provider, writeArtifact, 100, "always");

    const result = await runtime.runTurn("S", "save those results as a json file");

    expect(result.assistantText).toBe("SMALL-DONE");
    expect(provider.seen).toEqual(["small", "small"]);
  });

  it("escalates focused work after a source write", async () => {
    const provider = new ProgressRoutingProvider(1, {
      name: "write_file",
      args: { path: "src/app.ts", content: "export {};" },
    });
    const writeSource: Tool = {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: {} },
      mutates: true,
      serialize: () => "write src/app.ts",
      run: async () => ({
        ok: true,
        output: "wrote src/app.ts",
        diff: {
          path: join(dir, "src/app.ts"),
          before: "",
          after: "export {};",
          created: true,
        },
      }),
    };
    const runtime = smartRuntime(provider, writeSource, 100, "always");

    const result = await runtime.runTurn("S", "fix the focused app issue");

    expect(result.assistantText).toBe("LARGE-RECOVERY");
    expect(provider.seen).toEqual(["small", "large"]);
  });

  it("de-escalates after the large tier verifies the latest source edit", async () => {
    const provider = new SourceLeaseRoutingProvider();
    const writeSource: Tool = {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: {} },
      mutates: true,
      serialize: () => "write src/app.ts",
      run: async () => ({
        ok: true,
        output: "wrote src/app.ts",
        diff: {
          path: join(dir, "src/app.ts"),
          before: "",
          after: "export {};",
          created: true,
        },
      }),
    };
    const verify: Tool = {
      ...stubBash,
      run: async () => ({ ok: true, output: "1 pass" }),
    };
    const runtime = smartRuntime(provider, [writeSource, verify], 100, "always");

    const result = await runtime.runTurn("S", "fix the focused app issue");

    expect(result.assistantText).toBe("SMALL-FINAL");
    expect(provider.seen).toEqual(["small", "large", "small"]);
    const starts = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .map((event) => event.payload as { tier?: string; reason?: string });
    expect(starts[2]?.reason).toContain("lease released");
  });

  it("on_verify_fail: stays small through an edit whose verification passes", async () => {
    const provider = new SourceLeaseRoutingProvider();
    const writeSource: Tool = {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: {} },
      mutates: true,
      serialize: () => "write src/app.ts",
      run: async () => ({
        ok: true,
        output: "wrote src/app.ts",
        diff: { path: join(dir, "src/app.ts"), before: "", after: "export {};", created: true },
      }),
    };
    const verify: Tool = { ...stubBash, run: async () => ({ ok: true, output: "1 pass" }) };
    const runtime = smartRuntime(provider, [writeSource, verify], 100, "on_verify_fail");

    const result = await runtime.runTurn("S", "fix the focused app issue");

    expect(result.assistantText).toBe("SMALL-FINAL");
    expect(provider.seen).toEqual(["small", "small", "small"]);
  });

  it("on_verify_fail: escalates only once verification fails, not on the edit itself", async () => {
    const provider = new SourceLeaseRoutingProvider();
    const writeSource: Tool = {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: {} },
      mutates: true,
      serialize: () => "write src/app.ts",
      run: async () => ({
        ok: true,
        output: "wrote src/app.ts",
        diff: { path: join(dir, "src/app.ts"), before: "", after: "export {};", created: true },
      }),
    };
    const verify: Tool = { ...stubBash, run: async () => ({ ok: false, output: "1 fail" }) };
    const runtime = smartRuntime(provider, [writeSource, verify], 100, "on_verify_fail");

    const result = await runtime.runTurn("S", "fix the focused app issue");

    expect(result.assistantText).toBe("LARGE-FINAL");
    expect(provider.seen).toEqual(["small", "small", "large"]);
    const starts = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .map((event) => event.payload as { tier?: string; reason?: string });
    expect(starts[2]?.reason).toContain("verification_failed_pending_fix");
  });

  // Design decision (not a bug): `on_verify_fail`'s escalation is keyed to the edit epoch that
  // failed verification. Once large writes any further fix to the same file, the epoch moves on
  // and the escalation condition no longer matches, so the router hands back to small on the very
  // next call — before the fix has actually been re-verified. This is deliberate (this whole
  // branch's goal was reducing stickiness), so this test locks in the current behavior rather
  // than changing it. See the `smart.escalate_on_code_edit` row in README.md.
  it("on_verify_fail: a further fix edit after escalation drops back to small before re-verification", async () => {
    const provider = new VerifyFailThenFixEditRoutingProvider();
    const writeSource: Tool = {
      name: "write_file",
      description: "write",
      parameters: { type: "object", properties: {} },
      mutates: true,
      serialize: () => "write src/app.ts",
      run: async () => ({
        ok: true,
        output: "wrote src/app.ts",
        diff: { path: join(dir, "src/app.ts"), before: "", after: "export {};", created: true },
      }),
    };
    const verify: Tool = { ...stubBash, run: async () => ({ ok: false, output: "1 fail" }) };
    const runtime = smartRuntime(provider, [writeSource, verify], 100, "on_verify_fail");

    const result = await runtime.runTurn("S", "fix the focused app issue");

    expect(result.assistantText).toBe("SMALL-FINAL");
    expect(provider.seen).toEqual(["small", "small", "large", "small"]);
    const starts = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .map((event) => event.payload as { tier?: string; reason?: string });
    expect(starts[2]?.reason).toContain("verification_failed_pending_fix");
    expect(starts[3]?.tier).toBe("small");
    expect(starts[3]?.reason ?? "").not.toContain("verification_failed_pending_fix");
  });

  it("escalates after three consecutive model-correctable tool failures", async () => {
    const provider = new ProgressRoutingProvider(5);
    const runtime = smartRuntime(provider, {
      ...stubBash,
      run: async () => ({ ok: false, errorCode: "TOOL_FAILED", errorMessage: "failed" }),
    });

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("LARGE-RECOVERY");
    expect(provider.seen).toEqual(["small", "small", "small", "large"]);
    const large = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .find((event) => (event.payload as { tier?: string }).tier === "large");
    expect((large?.payload as { reason?: string }).reason).toContain(
      "consecutive_tool_failures>=3",
    );
  });

  it("counts empty retrieval results as failed progress and escalates on repeated discovery", async () => {
    const provider = new ProgressRoutingProvider(5, {
      name: "web_search",
      args: { query: "missing evidence" },
    });
    const webSearch: Tool = {
      name: "web_search",
      description: "search",
      parameters: { type: "object", properties: {} },
      mutates: false,
      serialize: () => "web_search missing evidence",
      run: async () => ({ ok: true, output: "(no results)" }),
    };
    const runtime = smartRuntime(provider, webSearch);

    const result = await runtime.runTurn("S", "look up the current weather");

    expect(result.assistantText).toBe("LARGE-RECOVERY");
    expect(provider.seen).toEqual(["small", "small", "large"]);
    const misses = log
      .query("S")
      .filter((event) => (event.payload as { kind?: string }).kind === "retrieval_miss");
    expect(misses).toHaveLength(2);
  });

  it("keeps the large tier through synthesis after it recovers a failed-tool streak", async () => {
    const provider = new FailureLeaseRoutingProvider();
    let executions = 0;
    const runtime = smartRuntime(provider, {
      ...stubBash,
      run: async () => {
        executions++;
        return executions <= 3
          ? { ok: false, errorCode: "TOOL_FAILED", errorMessage: "failed" }
          : { ok: true, output: "recovered" };
      },
    });

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("LARGE-DONE");
    expect(provider.seen).toEqual(["small", "small", "small", "large", "large"]);
    const lastStart = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .at(-1);
    expect((lastStart?.payload as { reason?: string }).reason).toContain("recovery_in_progress");
  });

  it("hands back to small after enough consecutive successes end the recovery lease", async () => {
    const provider = new FailureLeaseRoutingProvider();
    let executions = 0;
    const runtime = smartRuntime(
      provider,
      {
        ...stubBash,
        run: async () => {
          executions++;
          return executions <= 3
            ? { ok: false, errorCode: "TOOL_FAILED", errorMessage: "failed" }
            : { ok: true, output: "recovered" };
        },
      },
      100,
      "never",
      1, // deescalateAfterSuccesses
    );

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("SMALL-DONE");
    expect(provider.seen).toEqual(["small", "small", "small", "large", "small"]);
    const lastStart = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .at(-1);
    expect((lastStart?.payload as { reason?: string }).reason).not.toContain(
      "recovery_in_progress",
    );
  });

  it("keeps the recovery lease active across held iterations until enough successes accrue, then releases it", async () => {
    const provider = new RecoveryLeaseGrantResetProvider();
    const runtime = smartRuntime(provider, stubBash);

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("SMALL-RELEASED");
    expect(provider.seen).toEqual(["small", "small", "small", "large", "large", "small"]);
    const starts = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .map((event) => event.payload as { tier?: string; reason?: string });
    // Only 1 success has accrued since the lease was granted at call 4 (deescalateAfterSuccesses
    // defaults to 2), so call 5 must still be under the recovery lease on the large tier.
    expect(starts[4]?.tier).toBe("large");
    expect(starts[4]?.reason ?? "").toContain("recovery_in_progress");
    // The 2nd consecutive success (accrued during call 5's execution, while the lease was still
    // held from call 4) clears the threshold, so call 6 must actually release back to small —
    // proving the counter reached 2 across two iterations the lease continued to hold, rather
    // than being wiped back to 0 on the second iteration (the follow-up bug this test also
    // guards against).
    expect(starts[5]?.tier).toBe("small");
    expect(starts[5]?.reason ?? "").not.toContain("recovery_in_progress");
  });

  it("does not re-escalate after a single failure once a released lease is actually cleared", async () => {
    const provider = new LeaseReleaseRegressionProvider();
    const tool: Tool = {
      ...stubBash,
      run: async (args) => {
        const command = (args as { command?: string }).command;
        if (command === "verify") return { ok: true, output: "recovered" };
        return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "failed" };
      },
    };
    const runtime = smartRuntime(provider, tool, 100, "never", 2); // deescalateAfterSuccesses: 2

    const result = await runtime.runTurn("S", "look up the weather");

    expect(result.assistantText).toBe("SMALL-STABLE");
    expect(provider.seen).toEqual(["small", "small", "small", "large", "large", "small", "small"]);
    const starts = log
      .query("S")
      .filter((event) => event.type === "model_call_start")
      .map((event) => event.payload as { tier?: string; reason?: string });
    // Call 5 (index 4) is the 2nd success accrued on large while the lease is still held from
    // call 4 — not enough alone, so it stays large under recovery_in_progress.
    expect(starts[4]?.tier).toBe("large");
    expect(starts[4]?.reason ?? "").toContain("recovery_in_progress");
    // Call 6 (index 5) is the release itself: two successes on large clear the
    // (test-configured) deescalateAfterSuccesses threshold of 2, and this call's own tool call
    // then fails once.
    expect(starts[5]?.tier).toBe("small");
    expect(starts[5]?.reason ?? "").not.toContain("recovery_in_progress");
    // Call 7 (index 6) follows that single tool failure on small — nowhere near the real
    // escalate_after_failures threshold of 3 — and must not resurrect the released lease.
    expect(starts[6]?.tier).toBe("small");
    expect(starts[6]?.reason ?? "").not.toContain("recovery_in_progress");
  });
});

// Small tier: one tool call (so usedTools=true), then a final answer of `smallFinal` (may be empty).
// Large tier (finish pass): throws a provider error when `largeThrows`, else emits synthesis text.
class ScriptedProvider implements Provider {
  seen: string[] = [];
  constructor(private readonly opts: { smallFinal: string; largeThrows: boolean }) {}
  async listModels() {
    return [{ id: "small" }, { id: "large" }];
  }
  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.seen.push(req.model);
    if (req.model === "large") {
      if (this.opts.largeThrows) {
        throw new Error("PROVIDER_UNREACHABLE: chat failed: The operation timed out.");
      }
      yield { type: "text-delta", text: "LARGE-SYNTHESIS" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    const smallCalls = this.seen.filter((m) => m === "small").length;
    if (smallCalls === 1) {
      yield { type: "tool-call", call: { id: "c1", name: "bash", args: { command: "echo hi" } } };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    if (this.opts.smallFinal.length > 0) yield { type: "text-delta", text: this.opts.smallFinal };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

describe("finish-pass provider error is surfaced honestly (not 'only reasoning')", () => {
  it("finish pass errors and no fallback answer → finish_pass_error notice naming the large model", async () => {
    const provider = new ScriptedProvider({ smallFinal: "", largeThrows: true });
    const runtime = speedRuntime(provider, log, dir);
    const res = await runtime.runTurn("S", "build it");
    const notices = log.query("S").filter((e) => e.type === "notice");
    const fp = notices.find((e) => (e.payload as { kind?: string }).kind === "finish_pass_error");
    expect(fp).toBeDefined();
    const text = (fp!.payload as { text: string }).text;
    expect(text).toContain("large"); // the large-tier model id
    expect(text).toContain("timed out");
    expect(text).not.toContain("only reasoning");
    expect(res.assistantText.trim()).toBe("");
  });

  it("finish pass errors but the gather model answered → show the answer, no error notice (Option A)", async () => {
    const provider = new ScriptedProvider({ smallFinal: "SMALL-ANSWER", largeThrows: true });
    const runtime = speedRuntime(provider, log, dir);
    const res = await runtime.runTurn("S", "build it");
    expect(res.assistantText).toBe("SMALL-ANSWER");
    const fp = log
      .query("S")
      .filter((e) => e.type === "notice")
      .find((e) => (e.payload as { kind?: string }).kind === "finish_pass_error");
    expect(fp).toBeUndefined();
  });
});
