import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { EventLog } from "../../src/events/log";
import type { FormatResult } from "../../src/format/types";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolContext, ToolResult } from "../../src/tools/types";

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

class FakeWriteTool implements Tool {
  name = "fake_write";
  description = "writes";
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  serialize(args: unknown) {
    return `fake_write ${(args as { path: string }).path}`;
  }
  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const path = (args as { path: string }).path;
    return { ok: true, output: `wrote ${path}`, diff: { path, before: "", after: "x" } };
  }
}

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;
let providers: ProviderRegistry;
let tools: ToolRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-runtime-format-seam-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
  providers = new ProviderRegistry();
  tools = new ToolRegistry();
  tools.register(new FakeWriteTool());
});
afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("AgentRuntime format seam", () => {
  it("runs the formatter before diagnostics and emits its notice", async () => {
    const order: string[] = [];
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "a.py" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
      formatter: {
        async formatFiles(files): Promise<FormatResult[]> {
          order.push("format");
          expect(files).toEqual(["a.py"]);
          return [{ path: "a.py", changed: true, tool: "ruff" }];
        },
      },
      diagnostics: {
        async check() {
          return null;
        },
        async checkFiles() {
          order.push("diag");
          return [];
        },
      },
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "go");

    expect(order).toEqual(["format", "diag"]); // format precedes diagnostics

    const events = log.query(session.id);
    const notice = events.find(
      (e) =>
        e.type === "notice" &&
        (e.payload as { text: string }).text.includes("↻ formatted a.py (ruff)"),
    );
    expect(notice).toBeDefined();
  });
});
