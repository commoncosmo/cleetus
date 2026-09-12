import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { TodoItem, Tool, ToolContext, ToolResult } from "../../src/tools/types";

class ScriptedProvider implements Provider {
  constructor(private script: StreamEvent[][]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat() {
    const turn = this.script.shift();
    if (!turn) throw new Error("script empty");
    for (const e of turn) yield e;
  }
  async embed() {
    return [0];
  }
}

class FixtureTool implements Tool {
  seen: (TodoItem[] | undefined)[] = [];
  description = "fixture";
  parameters = { type: "object", properties: {} };
  constructor(
    public name: string,
    private readonly result: ToolResult,
  ) {}
  serialize() {
    return this.name;
  }
  async run(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    this.seen.push(ctx.sessionTodos);
    return this.result;
  }
}

const callTurnArgs = (id: string, name: string, args: unknown): StreamEvent[] => [
  { type: "tool-call", call: { id, name, args } },
  { type: "finish", reason: "tool-calls" },
];
const stopTurn = (): StreamEvent[] => [
  { type: "text-delta", text: "ok" },
  { type: "finish", reason: "stop" },
];

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-restore-todos-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(provider: Provider, toolList: Tool[]): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  for (const t of toolList) tools.register(t);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 10,
  });
}

describe("AgentRuntime.restoreTodos", () => {
  it("resets the working list observed by the next turn", async () => {
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([callTurnArgs("c1", "probe", {}), stopTurn()]);
    const runtime = makeRuntime(provider, [probe]);
    const restored: TodoItem[] = [{ content: "restored", status: "pending" }];
    runtime.seedTodoList("S", [{ content: "stale", status: "completed" }]);
    const r = runtime.restoreTodos("S", restored);
    expect(r.cleared).toBe(false);
    await runtime.runTurn("S", "go");
    expect(probe.seen.at(-1)).toEqual(restored);
  });

  it("clears the working list and reports cleared when given no todos", async () => {
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([callTurnArgs("c1", "probe", {}), stopTurn()]);
    const runtime = makeRuntime(provider, [probe]);
    runtime.seedTodoList("S", [{ content: "stale", status: "pending" }]);
    const r = runtime.restoreTodos("S", undefined);
    expect(r.cleared).toBe(true);
    await runtime.runTurn("S", "go");
    expect(probe.seen.at(-1)).toBeUndefined();
  });

  it("reports not-cleared when there was no prior list", () => {
    const runtime = makeRuntime(new ScriptedProvider([]), []);
    expect(runtime.restoreTodos("S", undefined)).toEqual({ cleared: false });
  });

  it("treats an empty-array snapshot identically to undefined", () => {
    const runtime = makeRuntime(new ScriptedProvider([]), []);
    runtime.seedTodoList("S", [{ content: "x", status: "pending" }]);
    expect(runtime.restoreTodos("S", [])).toEqual({ cleared: true });
  });
});
