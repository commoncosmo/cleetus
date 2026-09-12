import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAN_APPROVAL_MESSAGE,
  PLAN_MODE_REMINDER,
  approvedPlanStepTitles,
} from "../../src/agent/plan-mode";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";

class StubProvider implements Provider {
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "ok" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

class PlanProvider implements Provider {
  calls = 0;
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    yield {
      type: "text-delta",
      text:
        this.calls === 1
          ? [
              "# Implementation Plan",
              "",
              "### Step 1: Scaffold the project",
              "Run the initializer.",
              "",
              "### Step 2: Implement the CLI",
              "Write the source.",
              "",
              "### Step 3: Verify the result",
              "Run the tests.",
              "",
              "## Verification Checklist",
              "- [ ] tests pass",
              "- [ ] CLI launches",
            ].join("\n")
          : "implemented",
    };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-plan-reminder-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  holder: { plan: boolean },
  provider: Provider = new StubProvider(),
): AgentRuntime {
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
    maxToolLoops: 3,
    context: () => DEFAULT_CONTEXT,
    planMode: () => holder.plan,
  });
}

test("approvedPlanStepTitles prefers explicit steps and ignores fenced/checklist content", () => {
  expect(
    approvedPlanStepTitles(`
## Plan
### Step 1: Scaffold the project
\`\`\`md
Step 2: Not a real step
\`\`\`
### Step 2: Implement the CLI
### Step 3: Verify the result

## Verification Checklist
- [ ] build passes
- [ ] CLI launches
`),
  ).toEqual(["Scaffold the project", "Implement the CLI", "Verify the result"]);
});

test("approvedPlanStepTitles supports numbered plan headings and conservative plain lists", () => {
  expect(approvedPlanStepTitles("## Plan\n### 1. Inspect seams\n### 2. Make edits")).toEqual([
    "Inspect seams",
    "Make edits",
  ]);
  expect(approvedPlanStepTitles("## Plan\n1. Create files\n2. Add tests\n3. Run tests")).toEqual([
    "Create files",
    "Add tests",
    "Run tests",
  ]);
  expect(approvedPlanStepTitles("- [ ] build\n- [ ] test")).toEqual([]);
});

function userTurns(runtime: AgentRuntime) {
  return runtime.getMessages("s1").filter((m) => m.role === "user");
}

test("plan-mode turns carry the guidance reminder in the user turn", async () => {
  const holder = { plan: true };
  const runtime = makeRuntime(holder);
  await runtime.runTurn("s1", "how should we restructure auth?", new AbortController().signal);
  expect(String(userTurns(runtime)[0]!.content)).toContain(PLAN_MODE_REMINDER);
});

test("build-mode turns do NOT carry the reminder", async () => {
  const holder = { plan: false };
  const runtime = makeRuntime(holder);
  await runtime.runTurn("s1", "add a header", new AbortController().signal);
  expect(String(userTurns(runtime)[0]!.content)).not.toContain(PLAN_MODE_REMINDER);
});

test("reminder tracks live toggles across turns", async () => {
  const holder = { plan: true };
  const runtime = makeRuntime(holder);
  await runtime.runTurn("s1", "plan it", new AbortController().signal);
  holder.plan = false;
  await runtime.runTurn("s1", PLAN_APPROVAL_MESSAGE, new AbortController().signal);
  const turns = userTurns(runtime);
  expect(String(turns[0]!.content)).toContain(PLAN_MODE_REMINDER);
  expect(String(turns[1]!.content)).not.toContain(PLAN_MODE_REMINDER);
  expect(String(turns[1]!.content)).toContain("Plan mode has ended");
  expect(String(turns[1]!.content)).toContain("editing and shell tools are available");
});

test("an approved plan seeds its concrete steps as the working todo list before implementation", async () => {
  const holder = { plan: true };
  const runtime = makeRuntime(holder, new PlanProvider());
  await runtime.runTurn("s1", "plan the CLI", new AbortController().signal);
  holder.plan = false;
  await runtime.runTurn("s1", PLAN_APPROVAL_MESSAGE, new AbortController().signal);

  expect(runtime.getSessionTodos("s1")).toEqual([
    { content: "Scaffold the project", status: "in_progress" },
    { content: "Implement the CLI", status: "pending" },
    { content: "Verify the result", status: "pending" },
  ]);
  const todoEnd = log
    .query("s1")
    .find(
      (event) =>
        event.type === "tool_call_end" &&
        (event.payload as { call?: { name?: string } }).call?.name === "todo_write",
    );
  expect(todoEnd).toBeDefined();
  const approvalEvents = log.query("s1");
  const approvalInput = approvalEvents.findIndex(
    (event) =>
      event.type === "user_input" &&
      (event.payload as { text?: string }).text === PLAN_APPROVAL_MESSAGE,
  );
  const seededTodo = approvalEvents.findIndex(
    (event) =>
      event.type === "tool_call_end" &&
      (event.payload as { call?: { name?: string } }).call?.name === "todo_write",
  );
  expect(approvalInput).toBeLessThan(seededTodo);
});
