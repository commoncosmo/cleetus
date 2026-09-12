import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, approvedSpecExecutionStepTitles } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
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

const T: TodoItem[] = [
  { content: "a", status: "completed" },
  { content: "b", status: "in_progress" },
];

const callTurn = (id: string, name: string): StreamEvent[] => [
  { type: "tool-call", call: { id, name, args: {} } },
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
  dir = await mkdtemp(join(tmpdir(), "cleetus-sesstodos-"));
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

describe("AgentRuntime session working-list tracking", () => {
  it("exposes the last untitled todos result as ctx.sessionTodos to the next tool", async () => {
    const emit = new FixtureTool("emit", { ok: true, output: "x", todos: T });
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([
      callTurn("c1", "emit"),
      callTurn("c2", "probe"),
      stopTurn(),
    ]);
    const runtime = makeRuntime(provider, [emit, probe]);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "go");
    expect(probe.seen[0]).toEqual(T);
  });

  it("retires a fully-completed working list at the next turn boundary", async () => {
    const done: TodoItem[] = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ];
    const emit = new FixtureTool("emit", { ok: true, output: "x", todos: done });
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([
      callTurn("c1", "emit"),
      stopTurn(),
      callTurn("c2", "probe"),
      stopTurn(),
    ]);
    const runtime = makeRuntime(provider, [emit, probe]);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "build it");
    await runtime.runTurn(s.id, "now fix a small thing");
    // A done list is not current work: it must not carry into the next turn (where the
    // post-compaction re-injector would otherwise feed it back to the model as live).
    expect(probe.seen[0]).toBeUndefined();
  });

  it("carries an incomplete working list across turns", async () => {
    const emit = new FixtureTool("emit", { ok: true, output: "x", todos: T }); // T has an in_progress
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([
      callTurn("c1", "emit"),
      stopTurn(),
      callTurn("c2", "probe"),
      stopTurn(),
    ]);
    const runtime = makeRuntime(provider, [emit, probe]);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "start");
    await runtime.runTurn(s.id, "continue");
    expect(probe.seen[0]).toEqual(T);
  });

  it("does not track a titled (named-list) result as the working list", async () => {
    const emit = new FixtureTool("emit", { ok: true, output: "x", todos: T });
    const named = new FixtureTool("named", {
      ok: true,
      output: "x",
      todos: T,
      todosTitle: "n (project)",
    });
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([
      callTurn("c1", "emit"),
      callTurn("c2", "named"),
      callTurn("c3", "probe"),
      stopTurn(),
    ]);
    const runtime = makeRuntime(provider, [emit, named, probe]);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "go");
    // probe must still see the untitled list T, not the titled one, and not undefined.
    expect(probe.seen[0]).toEqual(T);
  });

  it("clears the tracked working list on resetHistory", async () => {
    const emit = new FixtureTool("emit", { ok: true, output: "x", todos: T });
    const probe1 = new FixtureTool("probe1", { ok: true, output: "p" });
    const probe2 = new FixtureTool("probe2", { ok: true, output: "p" });
    const provider = new ScriptedProvider([
      callTurn("c1", "emit"),
      callTurn("c2", "probe1"),
      stopTurn(),
      callTurn("c3", "probe2"),
      stopTurn(),
    ]);
    const runtime = makeRuntime(provider, [emit, probe1, probe2]);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "set");
    expect(probe1.seen[0]).toEqual(T); // tracked before reset
    runtime.resetHistory(s.id);
    await runtime.runTurn(s.id, "probe");
    expect(probe2.seen[0]).toBeUndefined(); // cleared after reset
  });

  it("tracks a cleared (empty array) working list as [] (not undefined)", async () => {
    const clear = new FixtureTool("clear", { ok: true, output: "cleared", todos: [] });
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([
      callTurn("c1", "clear"),
      callTurn("c2", "probe"),
      stopTurn(),
    ]);
    const runtime = makeRuntime(provider, [clear, probe]);
    const s = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(s.id, "go");
    expect(probe.seen[0]).toEqual([]);
  });

  it("makes a seeded (restored) list available via ctx.sessionTodos", async () => {
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([callTurn("c1", "probe"), stopTurn()]);
    const runtime = makeRuntime(provider, [probe]);
    const s = sessions.create({ provider: "lm", model: "m" });
    runtime.seedTodoList(s.id, T);
    await runtime.runTurn(s.id, "go");
    expect(probe.seen[0]).toEqual(T);
  });

  it("exposes a defensive copy of the working list for UI hydration", () => {
    const provider = new ScriptedProvider([]);
    const runtime = makeRuntime(provider, []);
    const s = sessions.create({ provider: "lm", model: "m" });
    runtime.seedTodoList(s.id, T);
    const hydrated = runtime.getSessionTodos(s.id);
    expect(hydrated).toEqual(T);
    hydrated[0]!.status = "pending";
    expect(runtime.getSessionTodos(s.id)[0]!.status).toBe("completed");
    expect(runtime.getSessionTodos("missing")).toEqual([]);
  });

  it("seeds direct approved-spec execution from the spec's numbered approach", async () => {
    const probe = new FixtureTool("probe", { ok: true, output: "p" });
    const provider = new ScriptedProvider([callTurn("c1", "probe"), stopTurn()]);
    const runtime = makeRuntime(provider, [probe]);
    const s = sessions.create({ provider: "lm", model: "m" });
    runtime.loadSession(
      s.id,
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "spec-write",
              name: "write_file",
              args: {
                path: "docs/specs/widget.md",
                content:
                  "# Widget\n\n## Approach\n\n1. Add the widget model\n2. Render the widget\n3. Test both states",
              },
            },
          ],
        },
        { role: "tool", toolCallId: "spec-write", content: "wrote spec" },
      ],
      [],
    );
    await runtime.runTurn(s.id, "Implement the approved spec at `docs/specs/widget.md`.");
    expect(probe.seen[0]).toEqual([
      { content: "Add the widget model", status: "in_progress" },
      { content: "Render the widget", status: "pending" },
      { content: "Test both states", status: "pending" },
    ]);
  });
});

describe("approvedSpecExecutionStepTitles", () => {
  it("uses a bounded fallback for older sessions without the spec write payload", () => {
    expect(
      approvedSpecExecutionStepTitles("Implement the approved spec at `docs/specs/widget.md`.", []),
    ).toEqual([
      "Read and confirm the approved specification",
      "Implement the approved requirements",
      "Add or update focused tests",
      "Run final verification",
    ]);
  });

  it("does not seed arbitrary implementation prompts", () => {
    expect(approvedSpecExecutionStepTitles("Implement the widget.", [])).toEqual([]);
  });
});
