import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import type { CheckpointRecorder } from "../../src/checkpoint/types";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { TodoItem, Tool, ToolResult } from "../../src/tools/types";

// ---------------------------------------------------------------------------
// Shared test infrastructure (mirrors the pattern in runtime.test.ts)
// ---------------------------------------------------------------------------

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

/** A write tool whose result includes a diff (with a controllable `created` flag).
 *  Pass `fail: true` to return an unsuccessful result with no diff. */
class FakeWriteTool implements Tool {
  name: string;
  description = "writes";
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  constructor(
    private readonly opts: {
      before?: string;
      created?: boolean;
      fail?: boolean;
      name?: string;
    } = {},
  ) {
    this.name = opts.name ?? "fake_write";
  }
  serialize(args: unknown) {
    return `${this.name} ${(args as { path: string }).path}`;
  }
  async run(args: unknown): Promise<ToolResult> {
    const path = (args as { path: string }).path;
    if (this.opts.fail) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "nope" };
    }
    return {
      ok: true,
      output: `wrote ${path}`,
      diff: {
        path,
        before: this.opts.before ?? "old content",
        after: "new content",
        created: this.opts.created ?? false,
      },
    };
  }
}

/** A recording CheckpointRecorder that captures what it's called with. */
class RecordingRecorder implements CheckpointRecorder {
  begins: Array<{ userInput: string; historyLength: number; todos?: TodoItem[] }> = [];
  files: Array<{ path: string; before: string; created: boolean }> = [];

  begin(_sessionId: string, userInput: string, historyLength: number, todos?: TodoItem[]): void {
    this.begins.push({ userInput, historyLength, todos });
  }

  recordFile(path: string, before: string, created: boolean): void {
    this.files.push({ path, before, created });
  }
}

/** A recorder that throws on every call. */
class ThrowingRecorder implements CheckpointRecorder {
  begin(): void {
    throw new Error("begin boom");
  }
  recordFile(): void {
    throw new Error("recordFile boom");
  }
}

// ---------------------------------------------------------------------------
// Module-level setup
// ---------------------------------------------------------------------------

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;
let providers: ProviderRegistry;
let tools: ToolRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-rt-ckpt-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
  providers = new ProviderRegistry();
  tools = new ToolRegistry();
});

afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  scriptedProvider: Provider,
  opts: { recorder?: CheckpointRecorder; writeTool?: FakeWriteTool } = {},
) {
  providers.register("lm", scriptedProvider);
  if (opts.writeTool) tools.register(opts.writeTool);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 10,
    checkpoints: opts.recorder,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRuntime checkpoint hooks", () => {
  it("calls begin once per turn, with historyLength = 0 on the first turn", async () => {
    const recorder = new RecordingRecorder();
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "text-delta", text: "hello" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "first message");

    expect(recorder.begins).toHaveLength(1);
    expect(recorder.begins[0]!.userInput).toBe("first message");
    expect(recorder.begins[0]!.historyLength).toBe(0);
  });

  it("calls begin with historyLength > 0 on a subsequent turn", async () => {
    const recorder = new RecordingRecorder();
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "text-delta", text: "turn1" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "turn2" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "first");
    await runtime.runTurn(session.id, "second");

    expect(recorder.begins).toHaveLength(2);
    // First turn: history was empty before the user message
    expect(recorder.begins[0]!.historyLength).toBe(0);
    // Second turn: history has 2 messages (user + assistant) from turn 1
    expect(recorder.begins[1]!.historyLength).toBeGreaterThan(0);
    expect(recorder.begins[1]!.userInput).toBe("second");
  });

  it("calls recordFile after a successful file-mutating tool dispatch", async () => {
    const recorder = new RecordingRecorder();
    const writeTool = new FakeWriteTool({ before: "old stuff", created: false });
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: { id: "c1", name: "fake_write", args: { path: "src/foo.ts" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder, writeTool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "write something");

    expect(recorder.files).toHaveLength(1);
    expect(recorder.files[0]!.path).toBe("src/foo.ts");
    expect(recorder.files[0]!.before).toBe("old stuff");
    expect(recorder.files[0]!.created).toBe(false);
  });

  it("does NOT call recordFile when the tool dispatch fails (no diff)", async () => {
    const recorder = new RecordingRecorder();
    const writeTool = new FakeWriteTool({ fail: true });
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "x.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder, writeTool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "write something");

    expect(recorder.files).toHaveLength(0);
  });

  it("passes created=true when the tool result has created=true", async () => {
    const recorder = new RecordingRecorder();
    const writeTool = new FakeWriteTool({ before: "", created: true });
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "new.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder, writeTool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "create file");

    expect(recorder.files[0]!.created).toBe(true);
    expect(recorder.files[0]!.before).toBe("");
  });

  it("a throwing recorder does NOT break the turn — assistantText is still returned", async () => {
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "x.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "survived" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder: new ThrowingRecorder(), writeTool: new FakeWriteTool() },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "go");

    expect(result.assistantText).toBe("survived");
  });

  it("truncateHistory trims the model-facing history, observable via the next begin's historyLength", async () => {
    const recorder = new RecordingRecorder();
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "text-delta", text: "t1" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "t2" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "t3" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder },
    );
    const session = sessions.create({ provider: "lm", model: "m" });

    // Two turns build up history: [user, assistant, user, assistant] = 4 messages
    await runtime.runTurn(session.id, "turn1");
    await runtime.runTurn(session.id, "turn2");

    // History before turn3 = 4 messages. Truncate back to 0 (as if rewinding).
    runtime.truncateHistory(session.id, 0);

    // Third turn: begin should see historyLength = 0 (truncated)
    await runtime.runTurn(session.id, "turn3");

    expect(recorder.begins[2]!.historyLength).toBe(0);
  });

  it("truncateHistory is a no-op when length >= current history length", async () => {
    const recorder = new RecordingRecorder();
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "text-delta", text: "t1" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "t2" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { recorder },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "turn1");

    // After turn1: historyLength = 2 (user + assistant)
    // Truncating to 2 or more should be a no-op
    runtime.truncateHistory(session.id, 2);
    runtime.truncateHistory(session.id, 100);

    await runtime.runTurn(session.id, "turn2");

    // History before turn2 should still be 2 (no truncation happened)
    expect(recorder.begins[1]!.historyLength).toBe(2);
  });

  it("passes the session working todo list to begin", async () => {
    const recorder = new RecordingRecorder();
    const provider = new ScriptedProvider([
      [
        { type: "text-delta", text: "ok" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const runtime = makeRuntime(provider, { recorder });
    const todos: TodoItem[] = [{ content: "x", status: "pending" }];
    runtime.seedTodoList("S", todos);
    await runtime.runTurn("S", "go");
    expect(recorder.begins.at(-1)!.todos).toEqual(todos);
  });
});

describe("AgentRuntime write-outcome counts", () => {
  it("counts a failed structured write as failedWrites (no successfulEdits)", async () => {
    const writeTool = new FakeWriteTool({ fail: true, name: "write_file" });
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "write_file", args: { path: "x.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { writeTool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    const res = await runtime.runTurn(session.id, "go");
    expect(res.failedWrites).toBe(1);
    expect(res.successfulEdits).toBe(0);
  });

  it("counts a successful structured write as successfulEdits (no failedWrites)", async () => {
    const writeTool = new FakeWriteTool({ name: "write_file" });
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "write_file", args: { path: "x.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { writeTool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    const res = await runtime.runTurn(session.id, "go");
    expect(res.successfulEdits).toBe(1);
    expect(res.failedWrites).toBe(0);
  });

  it("does NOT count a failed non-write tool (e.g. bash) as failedWrites", async () => {
    // A tool named outside PATH_WRITING_TOOLS that fails must leave failedWrites at 0 —
    // a failing check command is not a blocked write.
    const bashTool = new FakeWriteTool({ fail: true, name: "bash" });
    const runtime = makeRuntime(
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "bash", args: { path: "irrelevant" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      { writeTool: bashTool },
    );
    const session = sessions.create({ provider: "lm", model: "m" });
    const res = await runtime.runTurn(session.id, "go");
    expect(res.failedWrites).toBe(0);
    expect(res.successfulEdits).toBe(0);
  });
});
