import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_LOOP_GUARD } from "../../src/config/loop-guard";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

/** Emits two tool calls to `write_file` (a tracked EDIT_TOOLS signature so LoopGuard's
 *  escape rule actually observes the calls — an untracked tool name yields a null
 *  signature and is never pushed into the guard's window), then finishes. */
class TwoToolCallsProvider implements Provider {
  private turn = 0;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.turn++;
    if (this.turn <= 2) {
      yield {
        type: "tool-call",
        call: { id: `c${this.turn}`, name: "write_file", args: { path: "/etc/passwd" } },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    }
  }
  async embed() {
    return [0];
  }
}

/** Emits two `write_file` tool calls to two distinct absolute paths OUTSIDE the project,
 *  then finishes. The stub tool returns a NON-OUT_OF_TREE result, so the only way
 *  `outOfTree` can become true is via the runtime's `pathEscapesProject` fallback. */
class TwoOutsidePathsProvider implements Provider {
  private turn = 0;
  constructor(private readonly paths: [string, string]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.turn++;
    if (this.turn <= 2) {
      yield {
        type: "tool-call",
        call: {
          id: `c${this.turn}`,
          name: "write_file",
          args: { path: this.paths[this.turn - 1] },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "done" };
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
  dir = await mkdtemp(join(tmpdir(), "cleetus-esc-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

describe("AgentRuntime loop-guard escape wiring", () => {
  it("emits a loop_guard notice after repeated OUT_OF_TREE tool results", async () => {
    const providers = new ProviderRegistry();
    providers.register("lm", new TwoToolCallsProvider());
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "always refuses out of tree",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      serialize: () => "write_file()",
      async run() {
        return { ok: false, errorCode: "OUT_OF_TREE", errorMessage: "refusing to write outside" };
      },
    });
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
      loopGuard: () => DEFAULT_LOOP_GUARD,
    });
    await runtime.runTurn("S", "go");
    const notices = log
      .query("S")
      .filter((e) => e.type === "notice")
      .filter((n) => (n.payload as { kind?: string }).kind === "loop_guard");
    expect(notices.length).toBeGreaterThanOrEqual(1);
  });

  it("emits a loop_guard notice via the pathEscapesProject fallback (no OUT_OF_TREE errorCode)", async () => {
    // Two absolute paths that are NOT under `dir` (the temp projectDir). mkdtemp puts `dir`
    // under $TMPDIR; these siblings live elsewhere under tmpdir but outside `dir`.
    const outsideA = join(tmpdir(), "cleetus-esc-outside-A", "a.txt");
    const outsideB = join(tmpdir(), "cleetus-esc-outside-B", "b.txt");
    const providers = new ProviderRegistry();
    providers.register("lm", new TwoOutsidePathsProvider([outsideA, outsideB]));
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "fails, but never reports OUT_OF_TREE itself",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      serialize: () => "write_file()",
      async run() {
        // Deliberately NOT OUT_OF_TREE — mimics a permission-denied ../-escape (ct7): the
        // errorCode disjunct is false, so outOfTree can only come from pathEscapesProject.
        return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "nope" };
      },
    });
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
      loopGuard: () => DEFAULT_LOOP_GUARD,
    });
    await runtime.runTurn("S", "go");
    const notices = log
      .query("S")
      .filter((e) => e.type === "notice")
      .filter((n) => (n.payload as { kind?: string }).kind === "loop_guard");
    expect(notices.length).toBeGreaterThanOrEqual(1);
  });
});
