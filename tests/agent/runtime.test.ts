import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { voiceCorrectionFor } from "../../src/agent/personalities";
import { PLAN_APPROVAL_MESSAGE } from "../../src/agent/plan-mode";
import { staticRouter } from "../../src/agent/router";
import {
  AgentRuntime,
  claimsCompletionWithUnfinishedTodos,
  isBatchableInspectionCall,
  prematureImplementationStop,
  repeatableSetupCommandKey,
  reportsUnfinishedTodoWork,
  transcriptUserInput,
  verificationReplayContext,
} from "../../src/agent/runtime";
import { SessionStore } from "../../src/agent/session";
import { SessionHistoryStore } from "../../src/agent/session-history";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { DEFAULT_LOOP_GUARD } from "../../src/config/loop-guard";
import { EventLog } from "../../src/events/log";
import { recoverToolCalls } from "../../src/providers/families";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { NoneSandbox } from "../../src/sandbox/none";
import { BashTool } from "../../src/tools/bash";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import { SaveFetchedJsonTool } from "../../src/tools/save-fetched-json";
import { TodoListWriteTool } from "../../src/tools/todo-list";
import { TodoListStore } from "../../src/tools/todo-list-store";
import { TodoWriteTool } from "../../src/tools/todo-write";
import type {
  TodoItem,
  Tool,
  ToolAuthorization,
  ToolContext,
  ToolResult,
} from "../../src/tools/types";
import { WriteFileTool } from "../../src/tools/write-file";
import { trackerHeader, trackerTodosFrom } from "../../src/ui/tui/todo-meter";
import { WebFetchCache } from "../../src/web/fetch-cache";

class ScriptedProvider implements Provider {
  readonly requests: ChatOptions[] = [];
  constructor(private script: StreamEvent[][]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions) {
    this.requests.push(opts);
    const turn = this.script.shift();
    if (!turn) throw new Error("script empty");
    for (const e of turn) yield e;
  }
  async embed() {
    return [0];
  }
}

class FakeTool implements Tool {
  name = "echo";
  description = "echo";
  parameters = { type: "object", properties: { text: { type: "string" } } };
  serialize(args: unknown) {
    return (args as { text: string }).text;
  }
  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    return { ok: true, output: `said:${(args as { text: string }).text}` };
  }
}

class FakeAuthorizedTool implements Tool {
  name = "job_start";
  description = "starts a declared client job";
  parameters = { type: "object", properties: {} };
  readonly declaredAuthorization: ToolAuthorization = {
    type: "client_job",
    kind: "sast.semgrep",
    effect: "read",
    target: "repo:current",
    limits: {
      timeoutMs: 60_000,
      maxOutputBytes: 1_048_576,
      maxArtifactBytes: 10_485_760,
    },
  };
  serialize() {
    return "job_start sast.semgrep (read) target=repo:current";
  }
  authorization() {
    return this.declaredAuthorization;
  }
  async run(): Promise<ToolResult> {
    return { ok: true, output: "started" };
  }
}

class FakeWriteTool implements Tool {
  name = "fake_write";
  description = "writes";
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  serialize(args: unknown) {
    return `fake_write ${(args as { path: string }).path}`;
  }
  async run(args: unknown): Promise<ToolResult> {
    const path = (args as { path: string }).path;
    return { ok: true, output: `wrote ${path}`, diff: { path, before: "", after: "x" } };
  }
}

class FakeTestRewriteTool implements Tool {
  name = "fake_test_rewrite";
  description = "rewrites an existing test file";
  parameters = { type: "object", properties: {} };
  serialize() {
    return "fake_test_rewrite tests/example.test.ts";
  }
  async run(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    return {
      ok: true,
      output: "rewrote tests/example.test.ts",
      diff: {
        path: join(ctx.projectDir, "tests/example.test.ts"),
        before: "test('a', () => expect(1).toBe(1));\ntest('b', () => expect(2).toBe(2));",
        after: "test('replacement', () => expect(1).toBe(1));",
      },
    };
  }
}

class FakeArtifactWriteTool implements Tool {
  name = "fake_artifact_write";
  description = "writes a JSON data artifact";
  parameters = { type: "object", properties: {} };
  serialize() {
    return "fake_artifact_write forecast.json";
  }
  async run(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
    return {
      ok: true,
      output: "wrote forecast.json",
      diff: {
        path: join(ctx.projectDir, "forecast.json"),
        before: "",
        after: '{"forecast":[]}',
        created: true,
      },
    };
  }
}

/** A tool that succeeds but produces NO diff (e.g. a read), so it never triggers diagnostics. */
class FakeReadTool implements Tool {
  constructor(readonly name = "fake_read") {}
  description = "reads";
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  serialize(args: unknown) {
    return `fake_read ${(args as { path: string }).path}`;
  }
  async run(args: unknown): Promise<ToolResult> {
    return { ok: true, output: `read ${(args as { path: string }).path}` };
  }
}

class FakeBashTool implements Tool {
  name = "bash";
  description = "shell";
  parameters = {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  };
  serialize(args: unknown) {
    return `bash ${(args as { command: string }).command}`;
  }
  async run(args: unknown): Promise<ToolResult> {
    return { ok: true, output: `ran ${(args as { command: string }).command}` };
  }
}

class CountingBashTool extends FakeBashTool {
  runs = 0;
  override async run(args: unknown): Promise<ToolResult> {
    this.runs++;
    return super.run(args);
  }
}

class FakeSmokeTool implements Tool {
  name = "smoke_run";
  description = "launches";
  parameters = { type: "object", properties: { command: { type: "string" } } };
  serialize(args: unknown) {
    return `smoke_run ${(args as { command?: string }).command ?? ""}`;
  }
  async run(): Promise<ToolResult> {
    return { ok: true, output: "✓ app reached ready state" };
  }
}

class RequiresPathTool implements Tool {
  ran = false;
  name = "needs_path";
  description = "needs a path";
  parameters = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
  serialize(args: unknown) {
    return `needs_path ${(args as { path?: string }).path}`;
  }
  async run(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    this.ran = true;
    return { ok: true, output: "ran" };
  }
}

let dir: string;
let db: Database;
let log: EventLog;
let sessions: SessionStore;
let providers: ProviderRegistry;
let tools: ToolRegistry;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-runtime-"));
  log = new EventLog(join(dir, "events.db"));
  db = new Database(join(dir, "sessions.db"));
  sessions = new SessionStore(db);
  providers = new ProviderRegistry();
  tools = new ToolRegistry();
  tools.register(new FakeTool());
});
afterEach(async () => {
  log.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("AgentRuntime", () => {
  it("only replays standalone verifiers and includes their working directory", () => {
    expect(verificationReplayContext("bash", { command: "bun run build" })).not.toBeNull();
    expect(
      verificationReplayContext("bash", { command: "bun test 2>&1 | grep 'passed|failed'" }),
    ).not.toBeNull();
    for (const command of [
      "rm -rf dist && bun run build",
      "cp logo.png public/logo.png; bun run build",
      "bun test | tee results.txt",
      "bun test > results.txt",
      "bun test && touch stamp",
      "bun test $(touch stamp)",
    ]) {
      expect(verificationReplayContext("bash", { command })).toBeNull();
    }
    expect(verificationReplayContext("bash", { command: "bun test", cwd: "a" })).not.toBe(
      verificationReplayContext("bash", { command: "bun test", cwd: "b" }),
    );
    expect(verificationReplayContext("bash", { command: "cd a && bun test" })).not.toBe(
      verificationReplayContext("bash", { command: "cd b && bun test" }),
    );
  });

  it("rebuilds after a shell asset copy and executes cleanup even with an unchanged verifier", async () => {
    await mkdir(join(dir, "public"));
    await writeFile(join(dir, "logo.png"), "mascot");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "bun build.ts" } }),
    );
    await writeFile(
      join(dir, "build.ts"),
      'import { cpSync, mkdirSync } from "node:fs"; mkdirSync("dist", {recursive:true}); cpSync("public", "dist", {recursive:true}); console.log("built");',
    );
    tools.register(new BashTool(new NoneSandbox(dir)));
    const round = (id: string, command: string): StreamEvent[] => [
      { type: "tool-call", call: { id, name: "bash", args: { command } } },
      { type: "finish", reason: "tool-calls" },
    ];
    const provider = new ScriptedProvider([
      round("first", "bun run build"),
      round("cached", "bun run build"),
      round("copy", "cp logo.png public/logo.png"),
      round("after-copy", "bun run build"),
      round("cleanup", "rm -rf dist && bun run build"),
      [
        { type: "text-delta", text: "Built the static assets." },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "Build the static assets.");
    expect(await readFile(join(dir, "dist/logo.png"), "utf8")).toBe("mascot");
    const events = log.query(session.id);
    const ends = events
      .filter((e) => e.type === "tool_call_end")
      .map((e) => e.payload as { call: { id: string }; ok: boolean; output?: string });
    expect(ends).toHaveLength(5);
    expect(ends.every((e) => e.ok)).toBe(true);
    expect(ends.find((e) => e.call.id === "cached")?.output).toContain('"reused":true');
    expect(ends.find((e) => e.call.id === "after-copy")?.output).toContain('"reused":false');
    expect(ends.find((e) => e.call.id === "cleanup")?.output).toContain('"reused":false');
  });

  it("distinguishes negated limitations from real unfinished work", () => {
    for (const text of [
      "All 7 items are complete — nothing left unfinished.",
      "There is no unfinished work.",
      "No tasks remain pending.",
      "Nothing is blocked. Complete.",
    ])
      expect(reportsUnfinishedTodoWork(text)).toBe(false);
    for (const text of [
      "The browser check remains unfinished.",
      "No unfinished code, but deployment is pending.",
      "The task isn't complete.",
      "Step 1 is done; later work remains.",
    ])
      expect(reportsUnfinishedTodoWork(text)).toBe(true);
  });

  it("recovers ccweb3's repeated named-list completion into the persisted working tracker", async () => {
    const stores = {
      global: new TodoListStore(join(dir, "global")),
      project: new TodoListStore(join(dir, "project")),
    };
    tools.register(new TodoListWriteTool(stores));
    tools.register(new TodoWriteTool());
    const historyStore = new SessionHistoryStore(db);
    const open: TodoItem[] = Array.from({ length: 7 }, (_, i) => ({
      content: `Task ${i + 1}`,
      status: i < 5 ? "completed" : i === 5 ? "in_progress" : "pending",
    }));
    const done: TodoItem[] = open.map((todo) => ({ ...todo, status: "completed" }));
    const round = (id: string, name: string, args: unknown): StreamEvent[] => [
      { type: "tool-call", call: { id, name, args } },
      { type: "finish", reason: "tool-calls" },
    ];
    const final: StreamEvent[] = [
      { type: "text-delta", text: "All 7 items are complete — nothing left unfinished." },
      { type: "finish", reason: "stop" },
    ];
    const provider = new ScriptedProvider([
      round("start", "todo_write", { todos: open }),
      round("wrong-list", "todo_list_write", { name: "ccweb3", todos: done }),
      final,
      round("reconcile", "todo_list_write", { name: "ccweb3", todos: done }),
      final,
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      historyStore,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "Wire up the product pages.");
    expect(runtime.getSessionTodos(session.id)).toEqual(done);
    expect(historyStore.load(session.id)?.todos).toEqual(done);
    const events = log.query(session.id);
    const namedEvent = events.find(
      (e) =>
        e.type === "tool_call_end" &&
        (e.payload as { call: { id: string } }).call.id === "wrong-list",
    )!;
    expect(trackerTodosFrom(namedEvent)).toBeNull(); // Ordinary saved lists remain independent.
    const recovered = events.find(
      (e) =>
        e.type === "tool_call_end" &&
        (e.payload as { call: { id: string } }).call.id === "reconcile",
    )!;
    expect(
      trackerHeader({
        todos: trackerTodosFrom(recovered)!,
        busy: false,
        currentElapsedMs: null,
        listElapsedMs: null,
      }),
    ).toContain("7/7 done");
    expect(
      events.filter(
        (e) =>
          e.type === "notice" && (e.payload as { kind?: string }).kind === "todo_tool_recovery",
      ),
    ).toHaveLength(1);
  });

  it.each(["different", "invalid-focus", "no-update"])(
    "keeps unfinished work visible when reconciliation returns %s",
    async (kind) => {
      const stores = {
        global: new TodoListStore(join(dir, "global")),
        project: new TodoListStore(join(dir, "project")),
      };
      tools.register(new TodoListWriteTool(stores));
      tools.register(new TodoWriteTool());
      const open: TodoItem[] = [
        { content: "Implement", status: "completed" },
        { content: "Verify", status: "in_progress" },
      ];
      const proposed: TodoItem[] =
        kind === "different"
          ? [{ content: "Unrelated task", status: "completed" }]
          : open.map((todo) => ({ ...todo, status: "in_progress" }));
      const final: StreamEvent[] = [
        { type: "text-delta", text: "Complete — nothing left unfinished." },
        { type: "finish", reason: "stop" },
      ];
      const script: StreamEvent[][] = [
        [
          { type: "tool-call", call: { id: "start", name: "todo_write", args: { todos: open } } },
          { type: "finish", reason: "tool-calls" },
        ],
        final,
        ...(kind === "no-update"
          ? []
          : [
              [
                {
                  type: "tool-call" as const,
                  call: {
                    id: "retry",
                    name: "todo_list_write",
                    args: { name: "saved", todos: proposed },
                  },
                },
                { type: "finish" as const, reason: "tool-calls" as const },
              ],
            ]),
        final,
      ];
      providers.register("lm", new ScriptedProvider(script));
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
      });
      const session = sessions.create({ provider: "lm", model: "m" });
      const result = await runtime.runTurn(session.id, "Implement and verify it.");
      expect(runtime.getSessionTodos(session.id)).toEqual(open);
      expect(result.assistantText).toContain(
        "1 planned todo item remains unfinished or unverified",
      );
      if (kind === "different") expect(stores.project.read("saved")).toEqual(proposed);
      if (kind === "invalid-focus") expect(stores.project.listNames()).toEqual([]);
    },
  );

  it("classifies only read-only shell inventory as batchable inspection", () => {
    expect(isBatchableInspectionCall("read_file", { path: "a.ts" })).toBe(true);
    expect(isBatchableInspectionCall("bash", { command: "rg -n controller src" })).toBe(true);
    expect(isBatchableInspectionCall("bash", { command: "sed -n '1,80p' src/app.ts" })).toBe(true);
    expect(isBatchableInspectionCall("bash", { command: "git status --short" })).toBe(true);
    expect(isBatchableInspectionCall("bash", { command: "bun test" })).toBe(false);
    expect(isBatchableInspectionCall("bash", { command: "rg foo src && apply_patch" })).toBe(false);
    expect(isBatchableInspectionCall("bash", { command: "rg foo src | tee inventory.txt" })).toBe(
      false,
    );
    expect(isBatchableInspectionCall("bash", { command: "find . -delete" })).toBe(false);
    expect(isBatchableInspectionCall("bash", { command: "ls; rm generated.ts" })).toBe(false);
  });

  it("recognizes only narrow idempotent Bun dependency setup commands", () => {
    expect(
      repeatableSetupCommandKey("bash", {
        command: "cd /project && bun add react-markdown remark-gfm",
      }),
    ).toBe("cd /project && bun add react-markdown remark-gfm");
    expect(repeatableSetupCommandKey("bash", { command: "bun install" })).toBe("bun install");
    expect(repeatableSetupCommandKey("bash", { command: "bun run build" })).toBeNull();
    expect(
      repeatableSetupCommandKey("bash", { command: "bun add zod && bun run build" }),
    ).toBeNull();
  });

  it("keeps internal system reminders out of transcript user input", () => {
    const prompt =
      "2\n\n<system-reminder>Return a complete revised replacement plan.</system-reminder>";
    expect(transcriptUserInput(prompt)).toBe("2");
    expect(transcriptUserInput("ordinary user text")).toBe("ordinary user text");
  });

  it("recognizes only unfinished implementation transitions as premature stops", () => {
    expect(
      prematureImplementationStop({
        text: "This is a utility. Let me find the actual component:",
        usedTools: true,
        unfinishedTodos: 2,
      }),
    ).toBe("intent");
    expect(
      prematureImplementationStop({
        text: "Now delete `rail.ts` and fix the layout import.",
        usedTools: true,
        unfinishedTodos: 2,
      }),
    ).toBe("intent");
    expect(
      prematureImplementationStop({
        text: "Implemented the component and tests pass.",
        usedTools: true,
        unfinishedTodos: 2,
      }),
    ).toBeNull();
    expect(
      prematureImplementationStop({
        text: "Let me know if you want changes.",
        usedTools: false,
        unfinishedTodos: 0,
      }),
    ).toBeNull();
  });

  it("recognizes whole-task completion claims that contradict unfinished todos", () => {
    expect(
      claimsCompletionWithUnfinishedTodos({
        text: "Everything in the spec is now implemented and verified.",
        usedTools: true,
        unfinishedTodos: 2,
      }),
    ).toBe(true);
    expect(
      claimsCompletionWithUnfinishedTodos({
        text: "Implemented the parser; the integration task remains unfinished.",
        usedTools: true,
        unfinishedTodos: 1,
      }),
    ).toBe(false);
    expect(
      claimsCompletionWithUnfinishedTodos({
        text: "Everything is complete.",
        usedTools: false,
        unfinishedTodos: 2,
      }),
    ).toBe(false);
  });

  it("completes a single text turn", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text-delta", text: "hello " },
        { type: "text-delta", text: "world" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "be terse",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "say hi");
    expect(result.assistantText).toBe("hello world");
    const events = log.query(session.id);
    expect(events.find((e) => e.type === "user_input")).toBeTruthy();
    expect(events.find((e) => e.type === "assistant_message")).toBeTruthy();
  });

  it("executes a requested tool call and loops", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "c1", name: "echo", args: { text: "boop" } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "got it" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "do echo");
    expect(result.assistantText).toBe("got it");
    const events = log.query(session.id);
    expect(events.find((e) => e.type === "tool_call_start")).toBeTruthy();
    expect(events.find((e) => e.type === "tool_call_end")).toBeTruthy();
  });

  it("executes an identical successful dependency setup only once per turn", async () => {
    const bash = new CountingBashTool();
    tools.register(bash);
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: { id: "install-1", name: "bash", args: { command: "bun add zod" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "install-2", name: "bash", args: { command: "bun add zod" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Dependencies are ready." },
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
      maxToolLoops: 5,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    await runtime.runTurn(session.id, "add zod");

    expect(bash.runs).toBe(1);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "successful_action_cache",
        ),
    ).toBe(true);
  });

  it("keeps implementation and XML todo recovery available after three cached checks", async () => {
    const bash = new CountingBashTool();
    tools.register(bash);
    tools.register(new WriteFileTool());
    tools.register(new TodoWriteTool());
    const initialTodos = [
      { content: "Create product data", status: "in_progress" },
      { content: "Build pages", status: "pending" },
    ];
    const updatedTodos = [
      { content: "Create product data", status: "completed" },
      { content: "Build pages", status: "in_progress" },
    ];
    const round = (id: string, name: string, args: unknown): StreamEvent[] => [
      { type: "tool-call", call: { id, name, args } },
      { type: "finish", reason: "tool-calls" },
    ];
    // Model the provider's actual recovery contract: XML only becomes a tool call
    // when that tool is still present in the request's schema roster.
    class XmlTodoProvider extends ScriptedProvider {
      override async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
        for await (const event of super.chat(opts)) {
          if (event.type === "text-delta" && event.text.startsWith("<tool_call>")) {
            yield event;
            const recovered = recoverToolCalls({
              content: event.text,
              reasoning: "",
              tools: opts.tools,
            });
            for (const call of recovered.calls) yield { type: "tool-call", call, recovered: true };
            yield { type: "finish", reason: recovered.calls.length ? "tool-calls" : "stop" };
          } else yield event;
        }
      }
    }
    const command = "bunx vitest run src/products.test.ts";
    const provider = new XmlTodoProvider([
      round("todos", "todo_write", { todos: initialTodos }),
      round("products", "write_file", {
        path: "src/products.ts",
        content: "export const products = []",
      }),
      ...[
        command,
        `${command} 2>&1 | grep -E 'passed|failed'`,
        `${command} 2>&1 | tail -8`,
        command,
      ].map((command, i) => round(`check-${i}`, "bash", { command })),
      [
        {
          type: "text-delta",
          text: `<tool_call><function=todo_write><parameter=todos>${JSON.stringify(updatedTodos)}</parameter></function></tool_call>`,
        },
      ],
      round("pages", "write_file", {
        path: "src/App.tsx",
        content: "export default function App() { return <main>CommonCosmo</main> }",
      }),
      round("check-after-edit", "bash", { command }),
      round("done", "todo_write", {
        todos: updatedTodos.map((todo) => ({ ...todo, status: "completed" })),
      }),
      [
        { type: "text-delta", text: "Created the product data and pages." },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 15,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "Create product data and build the pages.");

    expect(provider.requests[6]!.tools?.map((tool) => tool.name)).toContain("todo_write");
    expect(
      provider.requests[6]!.messages.find((message) => message.toolCallId === "check-3")?.content,
    ).toContain("Continue the remaining implementation");
    expect(
      provider.requests[9]!.messages.find((message) => message.toolCallId === "check-after-edit")
        ?.content,
    ).not.toContain("repeated requests reuse");
    expect(await readFile(join(dir, "src/App.tsx"), "utf8")).toContain("CommonCosmo");
    expect(bash.runs).toBe(2); // One real check, three cache hits, then a fresh check after editing.
    expect(result.assistantText).toBe("Created the product data and pages.");
    expect(result.stoppedReason).toBeUndefined();
    const events = log.query(session.id);
    expect(
      events.filter(
        (event) =>
          event.type === "notice" &&
          (event.payload as { kind?: string }).kind === "verification_cache",
      ),
    ).toHaveLength(3);
    expect(
      events.filter(
        (event) =>
          event.type === "tool_call_end" &&
          (event.payload as { call?: { name: string }; ok?: boolean }).call?.name ===
            "todo_write" &&
          (event.payload as { ok?: boolean }).ok,
      ),
    ).toHaveLength(3);
  });

  it("nudges a single post-verification re-read but still applies the follow-up edit", async () => {
    tools.register(new WriteFileTool());
    tools.register(new FakeReadTool("read_file"));
    tools.register(new FakeBashTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "write-fix",
              name: "write_file",
              args: { path: "src/fix.ts", content: "export const fixed = false;\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "build", name: "bash", args: { command: "bun run build" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "read-once", name: "read_file", args: { path: "src/fix.ts" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "read-again", name: "read_file", args: { path: "src/fix.ts" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "apply-fix",
              name: "write_file",
              args: { path: "src/fix.ts", content: "export const fixed = true; // real fix\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Applied the real fix." },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "fix src/fix.ts");

    // The redundant re-read is nudged, but tool access is NOT closed, so the follow-up edit lands.
    expect(await readFile(join(dir, "src/fix.ts"), "utf8")).toContain("real fix");
    expect(result.stoppedReason).not.toBe("convergence");
    expect(result.assistantText).toContain("Applied the real fix");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { text?: string }).text?.includes("editing remains open"),
        ),
    ).toBe(true);
  });

  it("closes tool access after sustained post-verification re-reading with no edit", async () => {
    tools.register(new WriteFileTool());
    tools.register(new FakeReadTool("read_file"));
    tools.register(new FakeBashTool());
    const readAgain = (id: string) => [
      {
        type: "tool-call" as const,
        call: { id, name: "read_file", args: { path: "src/fix.ts" } },
      },
      { type: "finish" as const, reason: "tool-calls" as const },
    ];
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "write-fix",
              name: "write_file",
              args: { path: "src/fix.ts", content: "export const fixed = true;\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "build", name: "bash", args: { command: "bun run build" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        readAgain("read-1"),
        readAgain("read-2"),
        readAgain("read-3"),
        [
          { type: "text-delta", text: "The fix is complete; the build passed." },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    await runtime.runTurn(session.id, "fix src/fix.ts");

    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { text?: string }).text?.includes("closed tool access"),
        ),
    ).toBe(true);
  });

  it("delivers built work with an unresolved-check qualification when a verification thrashes", async () => {
    tools.register(new WriteFileTool());
    tools.register({
      name: "bash",
      description: "shell",
      mutates: false,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      serialize: (a) => `bash ${(a as { command: string }).command}`,
      run: async (a) => {
        const command = (a as { command: string }).command;
        return /vitest|bun test/.test(command)
          ? { ok: false, errorCode: "TOOL_FAILED", errorMessage: "1 test failed" }
          : { ok: true, output: "ran" };
      },
    });
    tools.register({
      name: "edit_file",
      description: "edit",
      mutates: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      serialize: () => "edit_file",
      run: async () => ({ ok: true, diff: { path: "src/chat.ts", before: "a", after: "b" } }),
    });
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "w",
              name: "write_file",
              args: { path: "src/chat.ts", content: "export const chat = true;\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "v1",
              name: "bash",
              args: { command: "bunx vitest run src/chat.test.tsx" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "e1", name: "edit_file", args: { path: "src/chat.ts" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "v2",
              name: "bash",
              args: { command: "bunx vitest run src/chat.test.tsx" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Delivered the chat page; one test remains unresolved." },
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
      loopGuard: () => ({ ...DEFAULT_LOOP_GUARD, cmdFailAbort: 2 }),
      maxToolLoops: 12,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "build the chat page");

    // The turn is NOT discarded with a hard thrash stop; the built work is delivered...
    expect(result.stoppedReason).not.toBe("thrash");
    expect(result.assistantText).not.toContain("failed 2 times without converging");
    expect(await readFile(join(dir, "src/chat.ts"), "utf8")).toContain("chat");
    // ...with the non-converging check recorded as an explicit unresolved limitation.
    expect(result.assistantText).toContain(
      "did not pass after repeated attempts and remains unresolved",
    );
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "verification_thrash_qualified",
        ),
    ).toBe(true);
  });

  it("blocks an unexplained sibling Cleetus project before permission or execution", async () => {
    const active = join(dir, "todo6");
    const sibling = join(dir, "todo7");
    await mkdir(join(active, ".cleetus"), { recursive: true });
    await mkdir(join(sibling, ".cleetus"), { recursive: true });
    const bash = new CountingBashTool();
    tools.register(bash);
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: { id: "cross", name: "bash", args: { command: `ls -la ${sibling}/` } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "Stayed in the active project." },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    let permissionRequests = 0;
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: active,
      resolvePermission: async () => {
        permissionRequests++;
        return "allow";
      },
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "Inspect this project.");

    expect(result.assistantText).toBe("Stayed in the active project.");
    expect(bash.runs).toBe(0);
    expect(permissionRequests).toBe(0);
    expect(
      runtime
        .getMessages(session.id)
        .some(
          (message) =>
            message.role === "tool" && message.content.includes("Unexpected cross-project path"),
        ),
    ).toBe(true);
    expect(log.query(session.id).some((event) => event.type === "permission_request")).toBe(false);
  });

  it("advises batching after four consecutive single inspection-tool rounds", async () => {
    tools.register(new FakeReadTool("read_file"));
    const provider = new ScriptedProvider([
      ...["a.ts", "b.ts", "c.ts", "d.ts"].map((path, index) => [
        {
          type: "tool-call" as const,
          call: { id: `read-${index}`, name: "read_file", args: { path } },
        },
        { type: "finish" as const, reason: "tool-calls" as const },
      ]),
      [
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "inspect the project");

    expect(result.assistantText).toBe("done");
    expect(
      runtime
        .getMessages(session.id)
        .some((message) => message.role === "tool" && message.content.includes("EFFICIENCY NUDGE")),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .filter(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "inspection_batch_nudge",
        ),
    ).toHaveLength(1);
  });

  it("also advises batching after four single read-only bash inventory rounds", async () => {
    tools.register(new FakeBashTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        ...["pwd", "ls -la", "rg -n App src", "git status --short"].map((command, index) => [
          {
            type: "tool-call" as const,
            call: { id: `bash-${index}`, name: "bash", args: { command } },
          },
          { type: "finish" as const, reason: "tool-calls" as const },
        ]),
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    await runtime.runTurn(session.id, "inspect the project");

    expect(
      runtime
        .getMessages(session.id)
        .some((message) => message.role === "tool" && message.content.includes("EFFICIENCY NUDGE")),
    ).toBe(true);
  });

  it("runs one bounded completion audit after a direct coding turn edits files", async () => {
    tools.register(new FakeTestRewriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "edit-1", name: "fake_test_rewrite", args: {} } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Implemented it. All tests pass and the app launches." },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "Implemented the change; runtime launch was not verified." },
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
      completionAudit: true,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement the feature");

    expect(result.assistantText).toContain(
      "Implemented the change; runtime launch was not verified.",
    );
    expect(result.assistantText).toContain("Verification limitations recorded by Cleetus:");
    expect(result.assistantText).toContain("tests/example.test.ts reduced tests 2->1");
    const reminder = runtime
      .getMessages(session.id)
      .find(
        (message) =>
          message.role === "user" && message.content.includes("one bounded completion audit"),
      );
    expect(reminder?.content).toContain("tests/example.test.ts: tests 2->1");
    expect(reminder?.content).toContain("no successful test command was recorded");
    expect(reminder?.content).toContain("did not reach that runtime path");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "completion_audit",
        ),
    ).toBe(true);
  });

  it("blocks a completion audit from reopening files outside the active turn", async () => {
    tools.register(new WriteFileTool());
    tools.register(new FakeReadTool("read_file"));
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "write-current",
              name: "write_file",
              args: { path: "src/current.ts", content: "export const current = true;\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Implemented the focused change." },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "read-old", name: "read_file", args: { path: "src/old-task.ts" } },
          },
          {
            type: "tool-call",
            call: { id: "read-current", name: "read_file", args: { path: "src/current.ts" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Implemented the focused change; no further defect found." },
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
      completionAudit: true,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "fix src/current.ts");

    expect(result.assistantText).toContain("no further defect found");
    const toolMessages = runtime
      .getMessages(session.id)
      .filter((message) => message.role === "tool")
      .map((message) => message.content);
    expect(toolMessages.some((text) => text.includes("limited to files changed"))).toBe(true);
    expect(toolMessages.some((text) => text.includes("read src/current.ts"))).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "completion_audit_scope_guard",
        ),
    ).toBe(true);
  });

  it("makes a completion audit rerun verification when a trailing command hides its status", async () => {
    let bashExecutions = 0;
    const bash: Tool = {
      name: "bash",
      description: "shell",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      serialize: (args) => String((args as { command?: string }).command ?? ""),
      run: async () => {
        bashExecutions++;
        return { ok: true, output: "6 pass\n0 fail" };
      },
    };
    tools.register(new WriteFileTool());
    tools.register(bash);
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "write-app",
              name: "write_file",
              args: { path: "src/app.ts", content: "export const answer = 42;\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Everything is implemented. All tests pass." },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "masked-test",
              name: "bash",
              args: { command: 'bun test 2>&1; echo "EXIT=$?"' },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "clean-test", name: "bash", args: { command: "bun test" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Implemented the app. All tests pass." },
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
      completionAudit: true,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement the app");

    expect(result.assistantText).toBe("Implemented the app. All tests pass.");
    expect(bashExecutions).toBe(1);
    expect(
      runtime
        .getMessages(session.id)
        .some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("must preserve the verifier's exit status"),
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "completion_audit_guard",
        ),
    ).toBe(true);
  });

  it("skips semantic audit for focused UI work with current test and render evidence", async () => {
    const writePage: Tool = {
      name: "write_file",
      description: "write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      serialize: () => "write page",
      run: async (_args, ctx) => ({
        ok: true,
        output: "wrote page",
        diff: {
          path: join(ctx.projectDir, "index.html"),
          before: "",
          after: "<main>forecast</main>",
          created: true,
        },
      }),
    };
    const bash: Tool = {
      name: "bash",
      description: "shell",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      serialize: () => "bun test",
      run: async () => ({ ok: true, output: "3 pass" }),
    };
    const smokeRun: Tool = {
      name: "smoke_run",
      description: "smoke",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      serialize: () => "bunx playwright test",
      run: async () => ({
        ok: true,
        output: "✓ exited cleanly (code 0)\n1 passed",
      }),
    };
    tools.register(writePage);
    tools.register(bash);
    tools.register(smokeRun);
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "page",
              name: "write_file",
              args: { path: "index.html", content: "<main>forecast</main>" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "tests", name: "bash", args: { command: "bun test" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "smoke",
              name: "smoke_run",
              args: { command: "bunx playwright test" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "text-delta",
            text: "Implemented the page. Tests pass and the development server launches.",
          },
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
      completionAudit: true,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Create a simple html/tailwind page to display the forecast",
    );

    expect(result.assistantText).toContain("Implemented the page");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "completion_audit",
        ),
    ).toBe(false);
  });

  it("inherits render verification from an approved spec loaded from disk", async () => {
    await mkdir(join(dir, "docs/specs"), { recursive: true });
    await writeFile(
      join(dir, "docs/specs/chat-ui.md"),
      [
        "## Steps",
        "1. Implement the chat user interface.",
        "2. Verify the rendered layout and send interaction in a browser.",
        "",
        "## Final verification",
        "Run `bun test`, `bun run build`, and a smoke run.",
      ].join("\n"),
    );
    tools.register(new WriteFileTool());
    tools.register(new FakeBashTool());
    tools.register(new FakeSmokeTool());
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: {
            id: "write-ui",
            name: "write_file",
            args: { path: "src/chat-ui.ts", content: "export const chatUi = true;\n" },
          },
        },
        {
          type: "tool-call",
          call: { id: "test-ui", name: "bash", args: { command: "bun test" } },
        },
        {
          type: "tool-call",
          call: { id: "launch-ui", name: "smoke_run", args: { command: "bun run dev" } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "Implemented it; tests and launch pass." },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "text-delta",
          text: "Implemented it; tests and launch pass, but browser interaction is unverified.",
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 8,
      completionAudit: true,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Implement the approved spec at `docs/specs/chat-ui.md`.",
    );

    expect(result.assistantText).toContain("browser interaction is unverified");
    expect(
      provider.requests[0]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("build or server launch does not prove it rendered"),
      ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "completion_audit",
        ),
    ).toBe(true);
  });

  it("reuses vitest evidence and blocks audit-created smoke infrastructure", async () => {
    let bashExecutions = 0;
    let newTestWrites = 0;
    const bash: Tool = {
      name: "bash",
      description: "shell",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      serialize: () => "bash",
      run: async () => {
        bashExecutions++;
        return { ok: true, output: "7 tests passed" };
      },
    };
    const writeFile: Tool = {
      name: "write_file",
      description: "write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      serialize: () => "write smoke test",
      run: async (_args, ctx) => {
        newTestWrites++;
        return {
          ok: true,
          output: "wrote test",
          diff: {
            path: join(ctx.projectDir, "src/page.smoke.test.ts"),
            before: "",
            after: "test('page', () => {})",
            created: true,
          },
        };
      },
    };
    tools.register(new FakeTestRewriteTool());
    tools.register(bash);
    tools.register(writeFile);
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "edit-1", name: "fake_test_rewrite", args: {} } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: { id: "test-1", name: "bash", args: { command: "bunx vitest run" } },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "All tests pass and the page renders." },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "new-test",
              name: "write_file",
              args: { path: "src/page.smoke.test.ts", content: "test('page', () => {})" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "server-probe",
              name: "bash",
              args: {
                command: "bun run serve.ts &\nsleep 2\ncurl http://localhost:3000/",
              },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "text-delta",
            text: "All tests pass; runtime rendering was not verified.",
          },
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
      completionAudit: true,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement the page");

    expect(result.assistantText).toContain("All tests pass");
    expect(result.assistantText).not.toContain("no successful test command was recorded");
    expect(bashExecutions).toBe(1);
    expect(newTestWrites).toBe(0);
    expect(
      log
        .query(session.id)
        .filter(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "completion_audit_guard",
        ),
    ).toHaveLength(2);
  });

  it("does not run the implementation audit for a JSON data artifact", async () => {
    tools.register(new FakeArtifactWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: { id: "artifact-1", name: "fake_artifact_write", args: {} },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Saved forecast.json." },
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
      maxToolLoops: 5,
      completionAudit: true,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "save the results as JSON");

    expect(result.assistantText).toBe("Saved forecast.json.");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "completion_audit",
        ),
    ).toBe(false);
  });

  it("blocks lossy writes without preventing further retrieval before an exact cached save", async () => {
    const bash = new CountingBashTool();
    let searchRuns = 0;
    const cache = new WebFetchCache();
    const url = "https://api.example.test/forecast.json";
    const complete = '{"forecast":[1,2,3]}';
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: () => `web_fetch ${url}`,
      run: async () => {
        cache.set(url, { body: complete, finalUrl: url, complete: true });
        return {
          ok: true,
          output: `<untrusted-web-content url="${url}">\n${complete}\n</untrusted-web-content>`,
        };
      },
    };
    const search: Tool = {
      name: "web_search",
      description: "search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      serialize: () => "web_search JSON documentation",
      run: async () => {
        searchRuns++;
        return { ok: true, output: "documentation" };
      },
    };
    tools.register(fetch);
    tools.register(search);
    tools.register(bash);
    tools.register(new SaveFetchedJsonTool(cache));
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: { id: "fetch-json", name: "web_fetch", args: { url } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "download-json",
            name: "bash",
            args: { command: `curl -s "${url}" > routing_forecast.json` },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "research-json",
            name: "web_search",
            args: { query: "JSON forecast documentation" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "save-json",
            name: "save_fetched_json",
            args: { url, path: "routing_forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Retrieve the forecast and save it as routing_forecast.json",
    );

    expect(result.assistantText).toBe("Saved the exact fetched JSON to `routing_forecast.json`.");
    expect(await Bun.file(join(dir, "routing_forecast.json")).text()).toBe(complete);
    expect(bash.runs).toBe(0);
    expect(searchRuns).toBe(1);
    const messages = runtime.getMessages(session.id);
    expect(messages.find((message) => message.role === "user")?.content).toContain(
      "Data-artifact efficiency",
    );
    expect(
      messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("DATA ARTIFACT CHECKPOINT"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.includes("not available for exact retrieved artifacts"),
      ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "error" &&
            (event.payload as { phase?: string }).phase === "tool_unavailable",
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "artifact_ready_guard",
        ),
    ).toBe(false);
    expect(
      provider.requests.every(
        (request) =>
          !(request.tools ?? []).some((tool) => tool.name === "bash" || tool.name === "write_file"),
      ),
    ).toBe(true);
    expect(
      (
        log.query(session.id).find((event) => event.type === "user_input")?.payload as {
          text?: string;
        }
      ).text,
    ).toBe("Retrieve the forecast and save it as routing_forecast.json");
  });

  it("keeps entity lookup JSON intermediate and allows the requested payload fetch", async () => {
    const lookupUrl = "https://geo.example.test/search?q=Wilmette";
    const forecastUrl = "https://weather.example.test/forecast?lat=42.076&lon=-87.712";
    const lookup = '[{"name":"Wilmette","lat":"42.0760660","lon":"-87.7115555"}]';
    const forecast = '{"forecast":[{"name":"Today","temperature":77}]}';
    const cache = new WebFetchCache();
    let fetchRuns = 0;
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: (args) => `web_fetch ${(args as { url: string }).url}`,
      run: async (args) => {
        fetchRuns++;
        const url = (args as { url: string }).url;
        const body = url === lookupUrl ? lookup : forecast;
        cache.set(url, { body, finalUrl: url, complete: true });
        return {
          ok: true,
          output: `<untrusted-web-content url="${url}">\n${body}\n</untrusted-web-content>`,
        };
      },
    };
    tools.register(fetch);
    tools.register(new SaveFetchedJsonTool(cache));
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "lookup", name: "web_fetch", args: { url: lookupUrl } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: { id: "forecast", name: "web_fetch", args: { url: forecastUrl } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "save",
            name: "save_fetched_json",
            args: { url: forecastUrl, path: "forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Retrieve the Wilmette forecast and save it as forecast.json.",
    );

    expect(result.assistantText).toBe("Saved the exact fetched JSON to `forecast.json`.");
    expect(await Bun.file(join(dir, "forecast.json")).text()).toBe(forecast);
    expect(fetchRuns).toBe(2);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "artifact_ready_guard",
        ),
    ).toBe(false);
  });

  it("reuses entity-matched identifier evidence on the immediately following turn", async () => {
    const lookupUrl = "https://geo.example.test/search?q=Wilmette";
    const forecastUrl = "https://weather.example.test/forecast?lat=42.076&lon=-87.712";
    const lookup = '[{"name":"Wilmette","lat":"42.0760660","lon":"-87.7115555"}]';
    const forecast = '{"forecast":[{"name":"Today","temperature":77}]}';
    const cache = new WebFetchCache();
    let fetchRuns = 0;
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: (args) => `web_fetch ${(args as { url: string }).url}`,
      run: async (args) => {
        fetchRuns++;
        const url = (args as { url: string }).url;
        const body = url === lookupUrl ? lookup : forecast;
        cache.set(url, { body, finalUrl: url, complete: true });
        return {
          ok: true,
          output: `<untrusted-web-content url="${url}">\n${body}\n</untrusted-web-content>`,
        };
      },
    };
    tools.register(fetch);
    tools.register(new SaveFetchedJsonTool(cache));
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "lookup", name: "web_fetch", args: { url: lookupUrl } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "Found Wilmette's coordinates." },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "tool-call",
          call: { id: "forecast", name: "web_fetch", args: { url: forecastUrl } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "save",
            name: "save_fetched_json",
            args: { url: forecastUrl, path: "forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    await runtime.runTurn(session.id, "Look up coordinates for Wilmette, Illinois.");
    const result = await runtime.runTurn(
      session.id,
      "Retrieve the Wilmette forecast and save it as forecast.json.",
    );

    expect(result.assistantText).toBe("Saved the exact fetched JSON to `forecast.json`.");
    expect(await Bun.file(join(dir, "forecast.json")).text()).toBe(forecast);
    expect(fetchRuns).toBe(2);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "ungrounded_retrieval_identifier",
        ),
    ).toBe(false);
  });

  it("surfaces the immediately preceding complete JSON URL for a direct cached save", async () => {
    const forecastUrl = "https://weather.example.test/grid/Wilmette/forecast";
    const forecast = '{"forecast":[{"name":"Today","temperature":77}]}';
    const cache = new WebFetchCache();
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: () => `web_fetch ${forecastUrl}`,
      run: async () => {
        cache.set(forecastUrl, { body: forecast, finalUrl: forecastUrl, complete: true });
        return {
          ok: true,
          output: `<untrusted-web-content url="${forecastUrl}">\n${forecast}\n</untrusted-web-content>`,
        };
      },
    };
    tools.register(fetch);
    tools.register(new SaveFetchedJsonTool(cache));
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: { id: "forecast", name: "web_fetch", args: { url: forecastUrl } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "Today is 77°F." },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "save",
            name: "save_fetched_json",
            args: { url: forecastUrl, path: "forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    await runtime.runTurn(session.id, "Look up the current Wilmette forecast.");
    const result = await runtime.runTurn(
      session.id,
      "Retrieve the Wilmette forecast and save it as forecast.json.",
    );

    expect(result.assistantText).toBe("Saved the exact fetched JSON to `forecast.json`.");
    expect(await Bun.file(join(dir, "forecast.json")).text()).toBe(forecast);
    expect(provider.requests).toHaveLength(3);
    const followupUsers = provider.requests[2]!.messages.filter(
      (message) => message.role === "user",
    );
    expect(followupUsers.at(-1)?.content).toContain("Reusable retrieval");
    expect(followupUsers.at(-1)?.content).toContain(forecastUrl);
    const followupTools = (provider.requests[2]!.tools ?? []).map((tool) => tool.name);
    expect(followupTools).toContain("web_fetch");
    expect(followupTools).toContain("save_fetched_json");
    expect(followupTools).not.toContain("bash");
    expect(followupTools).not.toContain("write_file");
  });

  it("refuses to save an opaque fetched artifact until its requested identity is grounded", async () => {
    const wrongUrl = "https://api.weather.test/gridpoints/LOT/45,84/forecast";
    const correctUrl = "https://api.weather.test/gridpoints/LOT/75,76/forecast";
    const cache = new WebFetchCache();
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: (args) => `web_fetch ${(args as { url: string }).url}`,
      run: async (args) => {
        const url = (args as { url: string }).url;
        const body =
          url === correctUrl
            ? '{"periods":[{"name":"Today","temperature":77}]}'
            : '{"periods":[{"name":"Today","temperature":61}]}';
        cache.set(url, { body, finalUrl: url, complete: true });
        return {
          ok: true,
          output: `<untrusted-web-content url="${url}">\n${body}\n</untrusted-web-content>`,
        };
      },
    };
    const search: Tool = {
      name: "web_search",
      description: "search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      serialize: () => "web_search Wilmette forecast endpoint",
      run: async () => ({
        ok: true,
        output: `Wilmette forecast endpoint: ${correctUrl}`,
      }),
    };
    tools.register(fetch);
    tools.register(search);
    tools.register(new SaveFetchedJsonTool(cache));
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: { id: "wrong-fetch", name: "web_fetch", args: { url: wrongUrl } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "wrong-save",
            name: "save_fetched_json",
            args: { url: wrongUrl, path: "forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "resolve-identity",
            name: "web_search",
            args: { query: "Wilmette forecast endpoint" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: { id: "correct-fetch", name: "web_fetch", args: { url: correctUrl } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "correct-save",
            name: "save_fetched_json",
            args: { url: correctUrl, path: "forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 8,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Retrieve the Wilmette forecast and save it as forecast.json.",
    );

    expect(result.assistantText).toBe("Saved the exact fetched JSON to `forecast.json`.");
    expect(await Bun.file(join(dir, "forecast.json")).json()).toEqual({
      periods: [{ name: "Today", temperature: 77 }],
    });
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "artifact_identity_guard",
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .filter(
          (event) =>
            event.type === "tool_call_start" &&
            (event.payload as { call?: { name?: string } }).call?.name === "save_fetched_json",
        ),
    ).toHaveLength(1);
  });

  it("blocks guessed retrieval coordinates until a successful tool provides provenance", async () => {
    let fetchRuns = 0;
    const coordinates = "42.0638,-87.7184";
    const fetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: (args) => `web_fetch ${(args as { url: string }).url}`,
      run: async (args) => {
        fetchRuns++;
        const url = (args as { url: string }).url;
        return {
          ok: true,
          output: `<untrusted-web-content url="${url}">Sunny</untrusted-web-content>`,
        };
      },
    };
    const search: Tool = {
      name: "web_search",
      description: "search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      serialize: () => "web_search Wilmette coordinates",
      run: async () => ({
        ok: true,
        output: `Wilmette coordinates: ${coordinates}`,
      }),
    };
    tools.register(fetch);
    tools.register(search);
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: {
            id: "guessed",
            name: "web_fetch",
            args: { url: `https://api.example.test/points/${coordinates}` },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "discover",
            name: "web_search",
            args: { query: "Wilmette Illinois coordinates" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "grounded",
            name: "web_fetch",
            args: { url: `https://api.example.test/points/${coordinates}` },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "The retrieved forecast is sunny." },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 6,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Look up the current weather forecast for Wilmette, Illinois.",
    );

    expect(result.assistantText).toBe("The retrieved forecast is sunny.");
    expect(fetchRuns).toBe(1);
    expect(
      runtime
        .getMessages(session.id)
        .some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("do not guess intermediate identifiers"),
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .filter((event) => event.type === "permission_request")
        .map((event) => (event.payload as { tool?: string }).tool),
    ).toEqual(["web_search", "web_fetch"]);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "ungrounded_retrieval_identifier",
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_identifier_resolution",
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "retrieval_stalled",
        ),
    ).toBe(false);
  });

  it("uses the exact cache when visible JSON is capped and completes without synthesis", async () => {
    const url = "https://api.example.test/forecast.json";
    const complete = `{"forecast":"${"x".repeat(1_500)}"}`;
    const cache = new WebFetchCache();
    cache.set(url, { body: complete, finalUrl: url, complete: true });
    const longFetch: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: () => `web_fetch ${url}`,
      run: async () => ({
        ok: true,
        output: `<untrusted-web-content url="${url}">\n${complete}\n</untrusted-web-content>`,
      }),
    };
    const bash = new CountingBashTool();
    tools.register(longFetch);
    tools.register(bash);
    tools.register(new SaveFetchedJsonTool(cache));
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "fetch", name: "web_fetch", args: { url } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: { id: "stdout", name: "bash", args: { command: `curl -s "${url}"` } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "download",
            name: "bash",
            args: { command: `curl -s "${url}" > routing_forecast.json` },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "save",
            name: "save_fetched_json",
            args: { url, path: "routing_forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    providers.register("lm", provider);
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
      context: () => ({
        ...DEFAULT_CONTEXT,
        maxDeepToolResultChars: 1_000,
        maxLiveToolResultChars: 1_000,
      }),
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Retrieve the forecast and save it as routing_forecast.json",
    );

    expect(result.assistantText).toBe("Saved the exact fetched JSON to `routing_forecast.json`.");
    expect(await Bun.file(join(dir, "routing_forecast.json")).text()).toBe(complete);
    expect(bash.runs).toBe(0);
    expect(
      runtime
        .getMessages(session.id)
        .some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("not available for exact retrieved artifacts"),
        ),
    ).toBe(true);
    expect(
      runtime
        .getMessages(session.id)
        .some(
          (message) => message.role === "tool" && message.content.includes("ARTIFACT VALIDATED"),
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .filter(
          (event) =>
            event.type === "tool_call_start" &&
            (event.payload as { call?: { name?: string } }).call?.name === "web_fetch",
        ),
    ).toHaveLength(1);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "artifact_deterministic_completion",
        ),
    ).toBe(true);
    expect(provider.requests).toHaveLength(4);
  });

  it("blocks a lossy manual JSON copy and recovers with an exact cached save", async () => {
    const url = "https://api.example.test/forecast.json";
    const complete = '{"periods":[{"number":1},{"number":2},{"number":3}]}';
    const cache = new WebFetchCache();
    cache.set(url, { body: complete, finalUrl: url, complete: true });
    const fetchTool: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: () => `web_fetch ${url}`,
      run: async () => ({
        ok: true,
        output: `<untrusted-web-content url="${url}">\n${complete}\n</untrusted-web-content>`,
      }),
    };
    tools.register(fetchTool);
    tools.register(new WriteFileTool());
    tools.register(new SaveFetchedJsonTool(cache));
    const provider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "fetch", name: "web_fetch", args: { url } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "lossy-write",
            name: "write_file",
            args: {
              path: "forecast.json",
              content: '{"periods":[{"number":1},{"number":3}]}',
            },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "Saved the full forecast to forecast.json." },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "tool-call",
          call: {
            id: "exact-save",
            name: "save_fetched_json",
            args: { url, path: "forecast.json" },
          },
        },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 8,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Retrieve the forecast and save it as forecast.json.",
    );

    expect(result.assistantText).toBe("Saved the exact fetched JSON to `forecast.json`.");
    expect(await Bun.file(join(dir, "forecast.json")).text()).toBe(complete);
    expect(
      runtime
        .getMessages(session.id)
        .some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("not available for exact retrieved artifacts"),
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "artifact_lossy_write_guard",
        ),
    ).toBe(false);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "artifact_deterministic_completion",
        ),
    ).toBe(true);
    expect(provider.requests).toHaveLength(4);
  });

  it("does not automatically synthesize a second retrieval answer", async () => {
    const forecast: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: () => "web_fetch forecast",
      run: async () => ({
        ok: true,
        output: "NOAA forecast generated July 23, 2026. High 77°F. Low 65°F.",
      }),
    };
    tools.register(forecast);
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: { id: "forecast", name: "web_fetch", args: { url: "https://example.test" } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "text-delta",
          text: "- July 7, 2026: high 77°F.\n- Tonight: low 65°F.",
        },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "text-delta",
          text: "- July 23, 2026: high 77°F.\n- Tonight: low 65°F.\n- Source: NOAA.",
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "system",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Look up the current forecast and summarize it in three bullets.",
    );

    expect(result.assistantText).toContain("July 7, 2026");
    expect(provider.requests).toHaveLength(2);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "grounded_synthesis_repair",
        ),
    ).toBe(false);
  });

  it("keeps the personality pass available without automatic grounding repair", async () => {
    const forecast: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: () => "web_fetch forecast",
      run: async () => ({
        ok: true,
        output: "Forecast generated July 23, 2026. High 77°F.",
      }),
    };
    tools.register(forecast);
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: { id: "forecast", name: "web_fetch", args: { url: "https://example.test" } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        {
          type: "text-delta",
          text: "The forecast for July 7, 2026 has a high of 77°F.",
        },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "text-delta",
          text: "The forecast for July 7, 2026 has a high of 77°F.",
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
      voiceCorrection: (text) => voiceCorrectionFor("cleetus", text),
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "Look up the current forecast.");

    expect(result.assistantText).toContain("July 7, 2026");
    expect(provider.requests).toHaveLength(3);
    expect(
      log
        .query(session.id)
        .filter((event) => event.type === "model_call_start")
        .some((event) =>
          (event.payload as { reason?: string }).reason?.includes("personality-correction"),
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "grounded_synthesis_rejected",
        ),
    ).toBe(false);
  });

  it("leaves the single post-processing pass available for voice when structured facts are grounded", async () => {
    const forecast: Tool = {
      name: "web_fetch",
      description: "fetch",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      serialize: () => "web_fetch forecast",
      run: async () => ({
        ok: true,
        output: `<untrusted-web-content url="https://example.test/forecast">
{"periods":[{"temperature":75,"temperatureUnit":"F","probability":{"value":0,"unitCode":"wmoUnit:percent"}}]}
</untrusted-web-content>`,
      }),
    };
    tools.register(forecast);
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: { id: "forecast", name: "web_fetch", args: { url: "https://example.test" } },
        },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "- The high is 75°F.\n- Rain probability is 0%." },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "text-delta",
          text: "- Reckon the high is 75°F.\n- Rain probability is 0%.",
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
      voiceCorrection: (text) => voiceCorrectionFor("cleetus", text),
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(
      session.id,
      "Look up the current forecast and summarize it in two bullets.",
    );

    expect(result.assistantText).toStartWith("- Reckon");
    expect(provider.requests).toHaveLength(3);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "grounded_synthesis_repair",
        ),
    ).toBe(false);
    const correctionNotice = log
      .query(session.id)
      .find(
        (event) =>
          event.type === "notice" &&
          (event.payload as { kind?: string }).kind === "personality_correction",
      );
    expect(correctionNotice).toBeDefined();
    expect((correctionNotice!.payload as { visibility?: string }).visibility).toBe("verbose");
  });

  it("runs one tool-free personality correction only when the final prose is bland", async () => {
    const provider = new ScriptedProvider([
      [
        {
          type: "text-delta",
          text: "The forecast was saved to `forecast.json`. The high is 77 F.",
        },
        { type: "finish", reason: "stop" },
      ],
      [
        {
          type: "text-delta",
          text: "Reckon that does it: the forecast was saved to `forecast.json`. The high is 77 F.",
        },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 5,
      voiceCorrection: (text) => voiceCorrectionFor("cleetus", text),
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "Summarize the result");

    expect(result.assistantText).toStartWith("Reckon");
    const starts = log.query(session.id).filter((event) => event.type === "model_call_start");
    expect(starts).toHaveLength(2);
    expect(provider.requests[1]!.reasoningEffort).toBe("low");
    expect(provider.requests[1]!.maxOutputTokens).toBe(1024);
    expect((starts[1]!.payload as { reason?: string }).reason).toContain("personality-correction");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "personality_correction",
        ),
    ).toBe(true);
  });

  it("continues when a tool-using model stops after only announcing its next action", async () => {
    tools.register(new TodoWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "todo-1",
              name: "todo_write",
              args: { todos: [{ content: "finish implementation", status: "in_progress" }] },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "This is a utility. Let me find the actual component:" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "Implemented the component and verified it." },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "todo-finish",
              name: "todo_write",
              args: { todos: [{ content: "finish implementation", status: "completed" }] },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Implemented the component and verified it." },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement it");

    expect(result.assistantText).toBe("Implemented the component and verified it.");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "premature_completion",
        ),
    ).toBe(true);
  });

  it("reconciles a working list updated this turn even without a whole-task completion claim", async () => {
    tools.register(new TodoWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "todo-start",
              name: "todo_write",
              args: {
                todos: [
                  { content: "implement feature", status: "completed" },
                  { content: "run verification", status: "in_progress" },
                ],
              },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "text-delta",
            text: "All green. Step 3 is in the books.",
          },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "todo-finish",
              name: "todo_write",
              args: {
                todos: [
                  { content: "implement feature", status: "completed" },
                  { content: "run verification", status: "completed" },
                ],
              },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Everything is implemented and verified." },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement it");

    expect(result.assistantText).toBe("Everything is implemented and verified.");
    expect(runtime.getSessionTodos(session.id).every((todo) => todo.status === "completed")).toBe(
      true,
    );
    expect(
      log
        .query(session.id)
        .filter(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "todo_completion_reconciliation",
        ),
    ).toHaveLength(1);
  });

  it("advises a tracker update without blocking useful later work", async () => {
    tools.register(new WriteFileTool());
    tools.register(new TodoWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "config-write",
              name: "write_file",
              args: { path: "src/config.ts", content: "export const config = {};\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "premature-ollama-write",
              name: "write_file",
              args: { path: "src/ollama.ts", content: "export const ollama = {};\n" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "config-todo",
              name: "todo_write",
              args: {
                todos: [
                  { content: "— Scaffolding", status: "completed" },
                  { content: "— Config Module (`src/config.ts`)", status: "in_progress" },
                  { content: "— Ollama Module (`src/ollama.ts`)", status: "pending" },
                ],
              },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "The config step is active; later work remains." },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    runtime.loadSession(
      session.id,
      [
        {
          role: "assistant",
          content:
            "# Plan\n\n## Step 1 — Scaffolding\n\n## Step 2 — Config Module (`src/config.ts`)\n\n## Step 3 — Ollama Module (`src/ollama.ts`)",
        },
      ],
      [],
    );

    await runtime.runTurn(session.id, PLAN_APPROVAL_MESSAGE);

    expect(await Bun.file(join(dir, "src/config.ts")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "src/ollama.ts")).exists()).toBe(true);
    expect(runtime.getSessionTodos(session.id)[1]?.status).toBe("in_progress");
    expect(
      runtime
        .getMessages(session.id)
        .some((message) => message.role === "tool" && message.content.includes("TRACKER REMINDER")),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .filter(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "todo_phase_transition",
        ),
    ).toHaveLength(1);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "todo_phase_checkpoint",
        ),
    ).toBe(false);
  });

  it("rejects an unsupported bulk-complete update for a seeded plan", async () => {
    tools.register(new TodoWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "unsupported-complete",
              name: "todo_write",
              args: {
                todos: [
                  { content: "— Create files", status: "completed" },
                  { content: "— Full Suite Verification", status: "completed" },
                ],
              },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "honest-update",
              name: "todo_write",
              args: {
                todos: [
                  { content: "— Create files", status: "in_progress" },
                  { content: "— Full Suite Verification", status: "pending" },
                ],
              },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          {
            type: "text-delta",
            text: "The promised file and verification remain incomplete.",
          },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    runtime.loadSession(
      session.id,
      [
        {
          role: "assistant",
          content: `# Plan

## Step 1 — Create files

## Step 2 — Full Suite Verification
Run \`bun test\`, \`tsc --noEmit\`, and a smoke test.

## File Summary
| File | Purpose |
|---|---|
| \`.env.example\` | configuration template |`,
        },
      ],
      [],
    );

    await runtime.runTurn(session.id, PLAN_APPROVAL_MESSAGE);

    expect(runtime.getSessionTodos(session.id).some((todo) => todo.status !== "completed")).toBe(
      true,
    );
    expect(
      runtime
        .getMessages(session.id)
        .some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("Cannot mark the seeded plan fully complete"),
        ),
    ).toBe(true);
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "todo_completion_evidence_guard",
        ),
    ).toBe(true);
  });

  it("delivers-and-qualifies when todo reconciliation does not close the list", async () => {
    tools.register(new TodoWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "todo-start",
              name: "todo_write",
              args: { todos: [{ content: "run verification", status: "in_progress" }] },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Everything is complete." },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "Everything is complete." },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement it");

    // Deliver-and-qualify: the built work is preserved, not discarded with a hard stop; the still
    // open todo is recorded as a limitation appended to the model's own summary.
    expect(result.stoppedReason).toBeUndefined();
    expect(result.assistantText).toContain("Everything is complete.");
    expect(result.assistantText).toContain("Verification limitations recorded by Cleetus:");
    expect(result.assistantText).toContain("run verification");
    expect(result.assistantText).not.toContain("did not accept the task as complete");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind ===
              "todo_completion_reconciliation_exhausted",
        ),
    ).toBe(true);
  });

  it("continues once after repeated empty completions interrupt unfinished tool work", async () => {
    tools.register(new TodoWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "todo-1",
              name: "todo_write",
              args: { todos: [{ content: "finish implementation", status: "in_progress" }] },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [{ type: "finish", reason: "stop" }],
        [{ type: "finish", reason: "stop" }],
        [
          { type: "text-delta", text: "Recovered, finished, and verified the implementation." },
          { type: "finish", reason: "stop" },
        ],
        [
          {
            type: "tool-call",
            call: {
              id: "todo-finish",
              name: "todo_write",
              args: { todos: [{ content: "finish implementation", status: "completed" }] },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Recovered, finished, and verified the implementation." },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement it");

    expect(result.assistantText).toBe("Recovered, finished, and verified the implementation.");
    expect(
      log
        .query(session.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "empty_nothing",
        ),
    ).toBe(false);
  });

  it("reports an honest incomplete stop when transition-only responses persist", async () => {
    tools.register(new TodoWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          {
            type: "tool-call",
            call: {
              id: "todo-1",
              name: "todo_write",
              args: { todos: [{ content: "finish implementation", status: "in_progress" }] },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Let me inspect the component:" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "Now I need to inspect the component:" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "I'll inspect the component next:" },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "implement it");

    expect(result.stoppedReason).toBe("premature_completion");
    expect(result.assistantText).toContain("implementation did not complete");
  });

  it("respects permission resolver returning deny", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "echo", args: { text: "x" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "ok skipped" },
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
      resolvePermission: async () => "deny",
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "do echo");
    expect(result.assistantText).toBe("ok skipped");
    const events = log.query(session.id);
    const toolEnd = events.find((e) => e.type === "tool_call_end");
    expect(toolEnd).toBeTruthy();
    expect((toolEnd?.payload as { ok: boolean }).ok).toBe(false);
  });

  it("passes declared tool authority through permission resolution and durable events", async () => {
    const authorizedTool = new FakeAuthorizedTool();
    tools.register(authorizedTool);
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "job-1", name: "job_start", args: {} } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "Job started." },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    let requestedAuthorization: ToolAuthorization | undefined;
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async ({ authorization }) => {
        requestedAuthorization = authorization;
        return "allow";
      },
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    const result = await runtime.runTurn(session.id, "Run the scanner.");

    expect(result.assistantText).toBe("Job started.");
    expect(requestedAuthorization).toEqual(authorizedTool.declaredAuthorization);
    const events = log.query(session.id);
    expect(
      (
        events.find((event) => event.type === "permission_request")?.payload as {
          authorization?: ToolAuthorization;
        }
      ).authorization,
    ).toEqual(authorizedTool.declaredAuthorization);
    expect(
      (
        events.find((event) => event.type === "permission_decision")?.payload as {
          authorization?: ToolAuthorization;
        }
      ).authorization,
    ).toEqual(authorizedTool.declaredAuthorization);
  });

  it("rejects an unknown tool name before prompting, listing available tools", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "print_tree", args: { path: "." } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    let permissionAsked = 0;
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => {
        permissionAsked++;
        return "allow";
      },
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "use print_tree");
    expect(result.assistantText).toBe("ok");

    const events = log.query(session.id);
    // No permission prompt for a tool that does not exist.
    expect(events.find((e) => e.type === "permission_request")).toBeUndefined();
    expect(permissionAsked).toBe(0);
    // An actionable error was logged AND fed back to the model: names the bad tool + lists real ones.
    const err = events.find(
      (e) => e.type === "error" && (e.payload as { phase?: string }).phase === "tool_args",
    );
    expect(err).toBeTruthy();
    const msg = (err!.payload as { message: string }).message;
    expect(msg).toContain("print_tree");
    expect(msg).toContain("echo"); // the one registered tool, surfaced so the model can correct
  });

  it("model error leaves history consistent for a subsequent turn", async () => {
    // First chat() call throws; second returns a normal text finish.
    let callCount = 0;
    const flakyProvider: Provider = {
      async listModels() {
        return [{ id: "m" }];
      },
      async *chat() {
        callCount++;
        if (callCount === 1) throw new Error("network blip");
        yield { type: "text-delta", text: "recovered" };
        yield { type: "finish", reason: "stop" };
      },
      async embed() {
        return [0];
      },
    };
    providers.register("lm", flakyProvider);
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    // First turn must reject
    await expect(runtime.runTurn(session.id, "first")).rejects.toThrow("network blip");

    // Second turn must succeed — history must be consistent (no [user, user] sequence)
    const result = await runtime.runTurn(session.id, "second");
    expect(result.assistantText).toBe("recovered");

    // Verify an error event was logged for the first turn
    const events = log.query(session.id);
    expect(events.find((e) => e.type === "error")).toBeTruthy();
  });

  it("permission throw on first of two tool calls still produces a result for the second, and a subsequent turn succeeds", async () => {
    // Turn 1: provider returns TWO tool calls in one batch, finish "tool-calls".
    // resolvePermission throws on the first invocation.
    // Turn 2: provider returns normal text — proves history is replayable.
    let permissionCallCount = 0;
    let permissionToolCallId: string | undefined;
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "tc1", name: "echo", args: { text: "first" } } },
          { type: "tool-call", call: { id: "tc2", name: "echo", args: { text: "second" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "all good" },
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
      resolvePermission: async ({ toolCallId }) => {
        permissionCallCount++;
        permissionToolCallId = toolCallId;
        if (permissionCallCount === 1) throw new Error("permission exploded");
        return "allow";
      },
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });

    // Turn 1 must resolve (not reject) — the runtime handles the throw internally.
    const turn1 = await runtime.runTurn(session.id, "do two things");
    expect(turn1.assistantText).toMatch(/permission resolution failed/i);
    expect(turn1.stoppedReason).toBe("permission_error");
    expect(permissionToolCallId).toBe("tc1");

    // A permission error event must have been logged.
    const eventsAfterTurn1 = log.query(session.id);
    expect(eventsAfterTurn1.find((e) => e.type === "error")).toBeTruthy();

    // Turn 2 must succeed — history must be internally consistent (no unmatched
    // toolCallIds) so the provider can replay it without errors.
    const turn2 = await runtime.runTurn(session.id, "follow up");
    expect(turn2.assistantText).toBe("all good");
  });

  it("ends a turn cleanly (no error) when the signal is aborted", async () => {
    const abortingProvider: Provider = {
      async listModels() {
        return [{ id: "m" }];
      },
      async *chat(opts) {
        if (opts.signal?.aborted) throw new Error("aborted");
        yield { type: "text-delta", text: "should not finish" };
        yield { type: "finish", reason: "stop" };
      },
      async embed() {
        return [0];
      },
    };
    providers.register("lm", abortingProvider);
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const ac = new AbortController();
    ac.abort();
    const result = await runtime.runTurn(session.id, "go", ac.signal);
    expect(result.assistantText).toBe("(cancelled)");
    expect(result.stoppedReason).toBe("cancelled");
    const events = log.query(session.id);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === "assistant_message" && (e.payload as { text: string }).text === "(cancelled)",
      ),
    ).toBe(true);
  });

  it("honors maxToolLoops: trips after the configured number of tool loops", async () => {
    // Provider always returns a tool-call with finish "tool-calls" — never stops on its own.
    // An explicit limit is exact and does not trigger an extra model summary call.
    let iteration = 0;
    const infiniteToolProvider: Provider = {
      async listModels() {
        return [{ id: "m" }];
      },
      async *chat() {
        iteration++;
        yield {
          type: "tool-call",
          call: { id: `c${iteration}`, name: "echo", args: { text: "loop" } },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
      async embed() {
        return [0];
      },
    };
    providers.register("lm", infiniteToolProvider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 3,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "loop forever");

    const events = log.query(session.id);
    const assistantMessages = events.filter((e) => e.type === "assistant_message");
    expect(assistantMessages.length).toBeGreaterThan(0);
    expect(result.assistantText.length).toBeGreaterThan(0);

    // Exactly maxToolLoops (3) tool loops ran.
    expect(events.filter((e) => e.type === "tool_call_end").length).toBe(3);
  });

  it("speed mode runs a large finish pass after a tool turn and its text wins", async () => {
    const s = sessions.create({ provider: "lm", model: "m" });
    // small tier: one tool call, then a (discardable) text answer.
    // large tier (finish pass): the real answer.
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "echo", args: { text: "hi" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "small-answer" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    const finishProvider = new ScriptedProvider([
      [
        { type: "text-delta", text: "LARGE-ANSWER" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("rm", finishProvider);
    const tiers = {
      small: { provider: "lm", model: "m" },
      large: { provider: "rm", model: "big" },
    };
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: {
        select: () => ({ choice: tiers.small, tier: "small", reason: "speed: gather" }),
        finishPass: () => ({ choice: tiers.large, tier: "large", reason: "speed: finish" }),
      },
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });
    const res = await runtime.runTurn(s.id, "go");
    expect(res.assistantText).toBe("LARGE-ANSWER");
    expect(res.assistantText).not.toBe("small-answer");
    expect(finishProvider.requests[0]!.messages).toHaveLength(1);
    expect(finishProvider.requests[0]!.messages[0]!.content).toContain("<current-request>\ngo");
    expect(finishProvider.requests[0]!.messages[0]!.content).toContain("said:hi");
    const tiersSeen = log
      .query(s.id)
      .filter((e) => e.type === "model_call_start")
      .map((e) => (e.payload as { tier?: string }).tier);
    expect(tiersSeen).toEqual(["small", "small", "large"]);
  });

  it("keeps the original answer when a streamed finish pass hits the normal watchdog", async () => {
    const s = sessions.create({ provider: "lm", model: "m" });
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "echo", args: { text: "hi" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "small-answer" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    const runawayFinish: Provider = {
      async listModels() {
        return [{ id: "big" }];
      },
      async *chat(opts) {
        while (true) {
          if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
          yield { type: "reasoning-delta", text: "still revising " };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
      async embed() {
        return [0];
      },
    };
    providers.register("rm", runawayFinish);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: {
        select: () => ({
          choice: { provider: "lm", model: "m" },
          tier: "small",
          reason: "speed: gather",
        }),
        finishPass: () => ({
          choice: { provider: "rm", model: "big" },
          tier: "large",
          reason: "speed: finish",
        }),
      },
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
      streamWatchdog: () => ({
        enabled: true,
        firstTokenMs: 1_000,
        noProgressMs: 1_000,
        maxCallMs: 40,
        repetitionRepeats: 0,
        reasoningLoopLines: 0,
      }),
    });

    const result = await runtime.runTurn(s.id, "go");

    expect(result.assistantText).toBe("small-answer");
    expect(log.query(s.id).some((event) => event.type === "reasoning_chunk")).toBe(true);
    expect(
      log
        .query(s.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "finish_pass_watchdog",
        ),
    ).toBe(true);
  });

  it("keeps the original answer and suppresses later automatic finish passes after an output ceiling", async () => {
    const s = sessions.create({ provider: "lm", model: "m" });
    const gatherProvider = new ScriptedProvider([
      [
        { type: "tool-call", call: { id: "c1", name: "echo", args: { text: "hi" } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "small-answer" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "tool-call", call: { id: "c2", name: "echo", args: { text: "again" } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "small-answer-2" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("lm", gatherProvider);
    const finishProvider = new ScriptedProvider([
      [
        { type: "text-delta", text: "unfinished rewritten answer" },
        { type: "finish", reason: "length" },
      ],
    ]);
    providers.register("rm", finishProvider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: {
        select: () => ({
          choice: { provider: "lm", model: "m" },
          tier: "small",
          reason: "speed: gather",
        }),
        finishPass: () => ({
          choice: { provider: "rm", model: "big" },
          tier: "large",
          reason: "speed: finish",
        }),
      },
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });

    const first = await runtime.runTurn(s.id, "go");
    const second = await runtime.runTurn(s.id, "go again");

    expect(first.assistantText).toBe("small-answer");
    expect(second.assistantText).toBe("small-answer-2");
    expect(finishProvider.requests).toHaveLength(1);
    expect(
      log
        .query(s.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "finish_pass_length",
        ),
    ).toBe(true);
    expect(
      log
        .query(s.id)
        .some(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "finish_pass_suppressed",
        ),
    ).toBe(true);
  });

  it("keeps a larger synthesis pass enabled after a smaller personality pass reaches its ceiling", async () => {
    const s = sessions.create({ provider: "rm", model: "big" });
    const finishProvider = new ScriptedProvider([
      [
        { type: "text-delta", text: "bland-one" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "unfinished personality edit" },
        { type: "finish", reason: "length" },
      ],
      [
        { type: "tool-call", call: { id: "c1", name: "echo", args: { text: "hi" } } },
        { type: "finish", reason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "small-answer" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "LARGE-ANSWER" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    providers.register("rm", finishProvider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: {
        select: () => ({
          choice: { provider: "rm", model: "big" },
          tier: "small",
          reason: "speed: gather",
        }),
        finishPass: () => ({
          choice: { provider: "rm", model: "big" },
          tier: "large",
          reason: "speed: finish",
        }),
      },
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
      voiceCorrection: (text) =>
        text === "bland-one"
          ? { systemPrompt: "", instruction: "Add the configured voice." }
          : null,
    });

    const first = await runtime.runTurn(s.id, "answer plainly");
    const second = await runtime.runTurn(s.id, "use the tool");

    expect(first.assistantText).toBe("bland-one");
    expect(second.assistantText).toBe("LARGE-ANSWER");
    expect(finishProvider.requests).toHaveLength(5);
    expect(finishProvider.requests[1]!.maxOutputTokens).toBe(1024);
    expect(finishProvider.requests[4]!.maxOutputTokens).toBe(4096);
  });

  it("on exhaustion emits a deterministic incomplete checkpoint without another model call", async () => {
    let calls = 0;
    const provider: Provider = {
      async listModels() {
        return [{ id: "m" }];
      },
      async *chat(opts) {
        calls++;
        if (calls <= 2) {
          yield { type: "tool-call", call: { id: `c${calls}`, name: "echo", args: { text: "x" } } };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        throw new Error(`unexpected model call with ${opts.tools?.length ?? 0} tools`);
      },
      async embed() {
        return [0];
      },
    };
    providers.register("lm", provider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => "be terse",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 2,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "scaffold something big");

    expect(result.assistantText).toContain("Paused incomplete");
    expect(result.assistantText).toContain("continue");
    expect(calls).toBe(2);

    const events = log.query(session.id);
    const assistantMessages = events.filter((e) => e.type === "assistant_message");
    const last = assistantMessages[assistantMessages.length - 1]!;
    expect((last.payload as { text: string }).text).toContain("Paused incomplete");
    expect((last.payload as { stoppedReason?: string }).stoppedReason).toBe("loop_limit");
  });

  it("resolves the systemPrompt getter once per turn (live switching)", async () => {
    const state = { prompt: "PERSONA-A" };
    const seenSystem: string[] = [];
    const capturingProvider: Provider = {
      async listModels() {
        return [{ id: "m" }];
      },
      async *chat(opts) {
        const sys = opts.messages.find((m) => m.role === "system");
        seenSystem.push(sys?.content ?? "");
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", reason: "stop" };
      },
      async embed() {
        return [0];
      },
    };
    providers.register("lm", capturingProvider);
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "m" }),
      systemPrompt: () => state.prompt,
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "first");
    state.prompt = "PERSONA-B"; // switch between turns
    await runtime.runTurn(session.id, "second");

    expect(seenSystem[0]).toBe("PERSONA-A");
    expect(seenSystem[1]).toBe("PERSONA-B");
  });

  it("tags a mid-loop cancellation with stoppedReason cancelled", async () => {
    const abortingProvider: Provider = {
      async listModels() {
        return [{ id: "m" }];
      },
      async *chat(opts) {
        if (opts.signal?.aborted) throw new Error("aborted");
        yield { type: "text-delta", text: "nope" };
        yield { type: "finish", reason: "stop" };
      },
      async embed() {
        return [0];
      },
    };
    providers.register("lm", abortingProvider);
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const ac = new AbortController();
    ac.abort();
    const result = await runtime.runTurn(session.id, "go", ac.signal);
    expect(result.assistantText).toBe("(cancelled)");
    const last = log
      .query(session.id)
      .filter((e) => e.type === "assistant_message")
      .at(-1)!;
    expect((last.payload as { stoppedReason?: string }).stoppedReason).toBe("cancelled");
  });

  it("logs reasoning (hidden) and records the served model", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "reasoning-delta", text: "analysis: do X" },
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop", model: "gpt-oss-120b" },
        ],
      ]),
    );
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: staticRouter({ provider: "lm", model: "requested-id" }),
      systemPrompt: () => "be terse",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });
    const session = sessions.create({ provider: "lm", model: "requested-id" });
    await runtime.runTurn(session.id, "hi");
    const events = log.query(session.id);
    const reasoning = events.find((e) => e.type === "reasoning");
    expect((reasoning?.payload as { text: string }).text).toBe("analysis: do X");
    const end = events.find((e) => e.type === "model_call_end");
    expect((end?.payload as { model?: string }).model).toBe("gpt-oss-120b");
    const notice = events.find((e) => e.type === "notice");
    expect((notice?.payload as { text: string }).text).toContain("gpt-oss-120b");
    expect((notice?.payload as { level?: string }).level).toBe("warn");
  });

  it("does not warn when served model matches requested", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "stop", model: "m" },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "hi");
    expect(log.query(session.id).find((e) => e.type === "notice")).toBeUndefined();
  });

  it("falls back to the small text when the finish pass errors", async () => {
    const s = sessions.create({ provider: "lm", model: "m" });
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "text-delta", text: "small-only" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    class BoomProvider extends ScriptedProvider {
      // biome-ignore lint/correctness/useYield: must throw before yielding to satisfy Provider.chat()
      async *chat(): AsyncGenerator<StreamEvent> {
        throw new Error("boom");
      }
    }
    providers.register("rm", new BoomProvider([]));
    const tiers = {
      small: { provider: "lm", model: "m" },
      large: { provider: "rm", model: "big" },
    };
    const runtime = new AgentRuntime({
      providers,
      tools,
      dispatcher: new ToolDispatcher(tools),
      log,
      router: {
        select: () => ({ choice: tiers.small, tier: "small", reason: "speed: gather" }),
        finishPass: () => ({ choice: tiers.large, tier: "large", reason: "speed: finish" }),
      },
      systemPrompt: () => "",
      projectDir: dir,
      resolvePermission: async () => "allow",
      maxToolLoops: 10,
    });
    const res = await runtime.runTurn(s.id, "go");
    expect(res.assistantText).toBe("small-only");
  });

  it("retries once when a completion is empty, then succeeds", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        [{ type: "finish", reason: "stop" }], // empty first attempt
        [
          { type: "text-delta", text: "recovered" },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "hi");
    expect(result.assistantText).toBe("recovered");
    const starts = log.query(session.id).filter((e) => e.type === "model_call_start");
    expect(starts.length).toBe(2); // original + one retry
  });

  it("emits a warn notice (not a silent turn) when still empty after retry", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        [{ type: "finish", reason: "stop" }],
        [{ type: "finish", reason: "stop" }],
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "hi");
    expect(result.assistantText).toBe("");
    const notice = log.query(session.id).find((e) => e.type === "notice");
    expect((notice?.payload as { level?: string }).level).toBe("warn");
    // No reasoning was produced → "empty_nothing"; the text retains the "no answer or tool call" phrasing.
    expect((notice?.payload as { kind?: string }).kind).toBe("empty_nothing");
    expect((notice?.payload as { text: string }).text).toContain("no answer or tool call");
    expect((notice?.payload as { text: string }).text).not.toContain("gpt-oss");
  });

  it("classifies an empty turn whose reasoning carries tool-call markup", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        // First attempt: plain reasoning, no markup, no content → empty turn → triggers retry.
        [
          { type: "reasoning-delta", text: "Let me think about this first." },
          { type: "finish", reason: "stop" },
        ],
        // Retry (final) attempt: reasoning carries leaked tool-call markup, still no content.
        // The notice must reflect THIS attempt's reasoning, so kind === empty_reasoning_markup.
        [
          { type: "reasoning-delta", text: "still only thinking <tool_call>{bad}</tool_call>" },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "hi");
    expect(result.assistantText).toBe("");
    const notice = log.query(session.id).find((e) => e.type === "notice");
    expect((notice?.payload as { kind?: string }).kind).toBe("empty_reasoning_markup");
    expect((notice?.payload as { text: string }).text).toContain("reasoning");
  });

  it("rejects a tool call missing a required arg without prompting or dispatching", async () => {
    const needsPath = new RequiresPathTool();
    tools.register(needsPath);
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "needs_path", args: { other: "x" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "fixed" },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "go");

    expect(needsPath.ran).toBe(false);
    expect(result.assistantText).toBe("fixed");
    const events = log.query(session.id);
    expect(events.find((e) => e.type === "permission_request")).toBeUndefined();
    expect(events.find((e) => e.type === "tool_call_start")).toBeUndefined();
    const argErr = events.find(
      (e) => e.type === "error" && JSON.stringify(e.payload).includes("tool_args"),
    );
    expect(argErr).toBeTruthy();
  });

  it("coalesces diagnostics: one checkFiles per step, attached to the last edit", async () => {
    tools.register(new FakeWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "a.ts" } } },
          { type: "tool-call", call: { id: "c2", name: "fake_write", args: { path: "b.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    let calls = 0;
    let seenFiles: string[] = [];
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
      diagnostics: {
        async check() {
          return null;
        },
        async checkFiles(files) {
          calls++;
          seenFiles = files;
          return [{ text: "⚠ 1 new diagnostics (tsc)\n  b.ts:1  TS2304  Cannot find name 'x'" }];
        },
      },
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "go");

    expect(calls).toBe(1); // one batch check for the two-edit step, not one per edit
    expect(seenFiles).toEqual(["a.ts", "b.ts"]);

    const events = log.query(session.id);
    const diag = events.find((e) => e.type === "diagnostics");
    expect(diag).toBeTruthy();
    expect((diag?.payload as { callId: string }).callId).toBe("c2"); // last edit
    expect((diag?.payload as { text: string }).text).toContain("1 new diagnostics");

    // tool_call_end no longer carries a diagnostics field.
    const ends = events.filter((e) => e.type === "tool_call_end");
    for (const e of ends) {
      expect((e.payload as { diagnostics?: string }).diagnostics).toBeUndefined();
    }
  });

  it("emits an assistant_message for an intermediate tool-using step's prose", async () => {
    tools.register(new FakeWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "text-delta", text: "Let me write the file." },
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "a.ts" } } },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "go");

    const texts = log
      .query(session.id)
      .filter((e) => e.type === "assistant_message")
      .map((e) => (e.payload as { text: string }).text);
    expect(texts).toEqual(["Let me write the file.", "done"]);
  });

  it("emits no intermediate assistant_message when the tool-using step has no prose", async () => {
    tools.register(new FakeWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "a.ts" } } },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "go");

    const texts = log
      .query(session.id)
      .filter((e) => e.type === "assistant_message")
      .map((e) => (e.payload as { text: string }).text);
    expect(texts).toEqual(["done"]);
  });

  it("a throwing checkFiles does not break the tool loop", async () => {
    tools.register(new FakeWriteTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_write", args: { path: "a.ts" } } },
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
      diagnostics: {
        async check() {
          return null;
        },
        async checkFiles() {
          throw new Error("checker exploded");
        },
      },
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    const result = await runtime.runTurn(session.id, "go");

    expect(result.assistantText).toBe("done"); // turn completed despite the throw
    const events = log.query(session.id);
    expect(events.find((e) => e.type === "diagnostics")).toBeUndefined(); // no event on throw
    const ends = events.filter(
      (e) => e.type === "tool_call_end" && (e.payload as { call: { id: string } }).call.id === "c1",
    );
    expect(ends).toHaveLength(1); // pairing intact
  });

  it("emits no diagnostics event for a step with no file-mutating edits", async () => {
    tools.register(new FakeReadTool());
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "tool-call", call: { id: "c1", name: "fake_read", args: { path: "a.ts" } } },
          { type: "finish", reason: "tool-calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ]),
    );
    let calls = 0;
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
      diagnostics: {
        async check() {
          return null;
        },
        async checkFiles() {
          calls++;
          return [];
        },
      },
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "go");

    expect(calls).toBe(0); // never called: no diff-producing tool ran
    expect(log.query(session.id).find((e) => e.type === "diagnostics")).toBeUndefined();
  });

  it("emits a reasoning_chunk per reasoning-delta plus the terminal reasoning blob", async () => {
    providers.register(
      "lm",
      new ScriptedProvider([
        [
          { type: "reasoning-delta", text: "first " },
          { type: "reasoning-delta", text: "second" },
          { type: "text-delta", text: "answer" },
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
    });
    const session = sessions.create({ provider: "lm", model: "m" });
    await runtime.runTurn(session.id, "go");

    const events = log.query(session.id);
    const chunks = events
      .filter((e) => e.type === "reasoning_chunk")
      .map((e) => (e.payload as { text: string }).text);
    expect(chunks).toEqual(["first ", "second"]);
    const reasoning = events.filter((e) => e.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0]!.payload as { text: string }).text).toBe("first second");
  });
});
