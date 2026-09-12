import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import { TodoListLoadTool, TodoListSaveTool } from "../../src/tools/todo-list";
import { TodoListStore } from "../../src/tools/todo-list-store";
import { TodoWriteTool } from "../../src/tools/todo-write";
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

const T: TodoItem[] = [
  { content: "a", status: "completed" },
  { content: "b", status: "pending" },
];

/** Issue a tool call with real args, then finish the turn for the next loop. */
const callTurnArgs = (id: string, name: string, args: unknown): StreamEvent[] => [
  { type: "tool-call", call: { id, name, args } },
  { type: "finish", reason: "tool-calls" },
];
const stopTurn = (): StreamEvent[] => [
  { type: "text-delta", text: "ok" },
  { type: "finish", reason: "stop" },
];

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-bridge-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
});
afterEach(async () => {
  log.close();
  db.close();
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

describe("AgentRuntime todo-list bridges (end-to-end)", () => {
  it("round-trips the working list through save and load via runTurn", async () => {
    const gdir = await mkdtemp(join(tmpdir(), "cleetus-bridge-g-"));
    const pdir = await mkdtemp(join(tmpdir(), "cleetus-bridge-p-"));
    const stores = { global: new TodoListStore(gdir), project: new TodoListStore(pdir) };
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([
      callTurnArgs("c1", "todo_write", { todos: T }), // track T as working list
      callTurnArgs("c2", "todo_list_save", { name: "snap" }), // persist (titled: no re-track)
      callTurnArgs("c3", "todo_write", { todos: [] }), // clear working list
      callTurnArgs("c4", "todo_list_load", { name: "snap" }), // re-adopt T as working list
      callTurnArgs("c5", "probe", {}), // capture ctx.sessionTodos
      stopTurn(),
    ]);
    const runtime = makeRuntime(provider, [
      new TodoWriteTool(),
      new TodoListSaveTool(stores),
      new TodoListLoadTool(stores),
      probe,
    ]);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "go");

    // load restored the working list (so the probe saw T after the clear+load)
    expect(probe.seen.at(-1)).toEqual(T);
    // save persisted the working list to the named project store
    expect(stores.project.read("snap")).toEqual(T);

    await rm(gdir, { recursive: true, force: true });
    await rm(pdir, { recursive: true, force: true });
  });
});
