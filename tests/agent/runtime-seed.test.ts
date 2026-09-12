import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type {
  ChatOptions,
  Message,
  ModelInfo,
  Provider,
  StreamEvent,
} from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import { renderTodoLines } from "../../src/tools/todo-write";
import type { TodoItem } from "../../src/tools/types";

class CapturingProvider implements Provider {
  lastMessages: Message[] = [];
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.lastMessages = opts.messages;
    yield { type: "finish", reason: "stop" };
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

const todos: TodoItem[] = [
  { content: "step one", status: "completed" },
  { content: "step two", status: "in_progress" },
];

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-seed-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(provider: Provider): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 5,
  });
}

describe("AgentRuntime.seedTodoList", () => {
  it("emits a tool_call_start and tool_call_end carrying the todos", () => {
    const runtime = makeRuntime(new CapturingProvider());
    runtime.seedTodoList("S", todos);
    const events = log.query("S");
    expect(events.map((e) => e.type)).toEqual(["tool_call_start", "tool_call_end"]);
    const end = events[1]!.payload as {
      ok: boolean;
      todos: TodoItem[];
      call: { id: string; name: string };
    };
    expect(end.ok).toBe(true);
    expect(end.todos).toEqual(todos);
    expect(end.call.name).toBe("todo_write");
    const start = events[0]!.payload as { call: { id: string; name: string } };
    expect(start.call.name).toBe("todo_write");
    expect(start.call.id).toBe((end as { call: { id: string } }).call.id);
  });

  it("seeds history so the next model call sees the list as a prior todo_write", async () => {
    const provider = new CapturingProvider();
    const runtime = makeRuntime(provider);
    runtime.seedTodoList("S", todos);
    await runtime.runTurn("S", "carry on");
    const msgs = provider.lastMessages;
    const assistant = msgs.find((m) => m.role === "assistant" && m.toolCalls?.length);
    expect(assistant?.toolCalls?.[0]?.name).toBe("todo_write");
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe(renderTodoLines(todos));
    expect(toolMsg?.toolCallId).toBe(assistant?.toolCalls?.[0]?.id);
    const assistantIdx = msgs.findIndex((m) => m.role === "assistant" && m.toolCalls?.length);
    const toolIdx = msgs.findIndex((m) => m.role === "tool");
    const userIdx = msgs.findIndex((m) => m.role === "user");
    expect(assistantIdx).toBeLessThan(toolIdx);
    expect(toolIdx).toBeLessThan(userIdx);
  });
});

describe("AgentRuntime.seedReviewFindings", () => {
  it("pushes an assistant message the model sees and emits one assistant_message event", () => {
    const runtime = makeRuntime(new CapturingProvider());
    const md = "## Review — 1 finding\n\n**R1** · 🔴 Critical · `a.ts:1`\nboom.";
    runtime.seedReviewFindings("R", md);

    const msgs = runtime.getMessages("R");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "assistant", content: md });

    const events = log.query("R");
    expect(events.map((e) => e.type)).toEqual(["assistant_message"]);
    expect((events[0]!.payload as { text: string }).text).toBe(md);
  });

  it("makes the findings visible to the next model call as prior assistant context", async () => {
    const provider = new CapturingProvider();
    const runtime = makeRuntime(provider);
    runtime.seedReviewFindings("R", "## Review — 1 finding\n\n**R2** · ⚪ Minor · `b.ts:2`\nnit.");
    await runtime.runTurn("R", "fix R2");
    const seeded = provider.lastMessages.find(
      (m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("R2"),
    );
    expect(seeded).toBeDefined();
  });
});

describe("AgentRuntime.recordOrchestrationSummary", () => {
  it("appends an assistant message to history and emits the event", () => {
    const runtime = makeRuntime(new CapturingProvider());
    const text = "I built this via orchestrated workers:\n ✓ X";
    runtime.recordOrchestrationSummary("s1", text);

    const msgs = runtime.getMessages("s1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "assistant", content: text });

    const events = log.query("s1");
    expect(events.map((e) => e.type)).toEqual(["assistant_message"]);
    expect((events[0]!.payload as { text: string }).text).toBe(text);
  });
});
