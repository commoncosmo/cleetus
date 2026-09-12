import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-sticky-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

const REMINDER = "<system-reminder>TDD applies</system-reminder>";

function makeRuntime(holder: { plan: boolean }): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", new StubProvider());
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
    // Fires only when the input contains "feature".
    triggeredSkillReminders: (input) => (input.includes("feature") ? [REMINDER] : []),
    planMode: () => holder.plan,
  });
}

function userTurns(runtime: AgentRuntime) {
  return runtime.getMessages("s1").filter((m) => m.role === "user");
}

test("replays a plan-mode-triggered skill onto the later approval turn", async () => {
  const holder = { plan: true };
  const runtime = makeRuntime(holder);
  await runtime.runTurn("s1", "create a feature", new AbortController().signal);
  holder.plan = false; // plan approved → mode restored before the implement turn
  await runtime.runTurn(
    "s1",
    "The plan is approved. Implement it now.",
    new AbortController().signal,
  );
  const turns = userTurns(runtime);
  expect(turns).toHaveLength(2);
  // The approval turn carries no trigger word yet still gets the reminder.
  expect(String(turns[1]!.content)).toContain(REMINDER);
  expect(String(turns[1]!.content)).toContain("approved");
});

test("persists across a second implementation follow-up turn", async () => {
  const holder = { plan: true };
  const runtime = makeRuntime(holder);
  await runtime.runTurn("s1", "create a feature", new AbortController().signal);
  holder.plan = false;
  await runtime.runTurn(
    "s1",
    "The plan is approved. Implement it now.",
    new AbortController().signal,
  );
  await runtime.runTurn("s1", "keep going", new AbortController().signal);
  expect(String(userTurns(runtime)[2]!.content)).toContain(REMINDER);
});

test("does NOT make a skill sticky when it only triggered outside plan mode", async () => {
  const holder = { plan: false }; // never in plan mode
  const runtime = makeRuntime(holder);
  await runtime.runTurn("s1", "create a feature", new AbortController().signal); // triggers directly
  await runtime.runTurn(
    "s1",
    "The plan is approved. Implement it now.",
    new AbortController().signal,
  );
  const turns = userTurns(runtime);
  expect(String(turns[0]!.content)).toContain(REMINDER); // direct trigger this turn
  expect(String(turns[1]!.content)).not.toContain(REMINDER); // not sticky
});

test("a fresh plan supersedes the prior arc", async () => {
  const holder = { plan: true };
  const runtime = makeRuntime(holder);
  await runtime.runTurn("s1", "create a feature", new AbortController().signal); // arc = {TDD}
  holder.plan = false;
  await runtime.runTurn(
    "s1",
    "The plan is approved. Implement it now.",
    new AbortController().signal,
  );
  // New plan that triggers nothing → entering plan mode resets the arc.
  holder.plan = true;
  await runtime.runTurn("s1", "plan a refactor of the header", new AbortController().signal);
  holder.plan = false;
  await runtime.runTurn(
    "s1",
    "The plan is approved. Implement it now.",
    new AbortController().signal,
  );
  expect(String(userTurns(runtime)[3]!.content)).not.toContain(REMINDER);
});
