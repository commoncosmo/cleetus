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
  dir = await mkdtemp(join(tmpdir(), "cleetus-skillinject-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

const REMINDER = "<system-reminder>TDD applies</system-reminder>";

function makeRuntime(): AgentRuntime {
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
    triggeredSkillReminders: (input) =>
      input.includes("feature") ? [{ name: "tdd", reminder: REMINDER }] : [],
  });
}

test("appends the reminder to the user turn content when a skill triggers", async () => {
  const runtime = makeRuntime();
  await runtime.runTurn("s1", "add a feature", new AbortController().signal);
  const first = runtime.getMessages("s1")[0]!;
  expect(first.role).toBe("user");
  expect(String(first.content)).toContain(REMINDER);
  expect(String(first.content)).toContain("add a feature");
  expect(
    log
      .query("s1")
      .some(
        (event) =>
          event.type === "notice" &&
          (event.payload as { kind?: string }).kind === "skill_auto_invoked",
      ),
  ).toBe(true);
});

test("leaves the turn unchanged when nothing triggers", async () => {
  const runtime = makeRuntime();
  await runtime.runTurn("s1", "hello there", new AbortController().signal);
  const first = runtime.getMessages("s1")[0]!;
  expect(String(first.content)).toBe("hello there");
});

test("re-injects on every matching turn (no dedup)", async () => {
  const runtime = makeRuntime();
  await runtime.runTurn("s1", "add a feature", new AbortController().signal);
  await runtime.runTurn("s1", "add another feature", new AbortController().signal);
  const userMsgs = runtime.getMessages("s1").filter((m) => m.role === "user");
  expect(userMsgs).toHaveLength(2);
  expect(userMsgs.every((m) => String(m.content).includes(REMINDER))).toBe(true);
});
