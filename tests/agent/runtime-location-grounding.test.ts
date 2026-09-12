import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  dir = await mkdtemp(join(tmpdir(), "cleetus-loc-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

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
  });
}
async function makeSubdirProject() {
  await mkdir(join(dir, "sample-app", "src"), { recursive: true });
  await writeFile(join(dir, "sample-app", "package.json"), "{}");
}
function lastUserContent(runtime: AgentRuntime): string {
  const u = runtime.getMessages("s1").filter((m) => m.role === "user");
  return String(u[u.length - 1]!.content);
}

test("a coding turn in a subdir-project session gets the grounding reminder", async () => {
  await makeSubdirProject();
  const runtime = makeRuntime();
  await runtime.runTurn("s1", "add a settings page", new AbortController().signal);
  const c = lastUserContent(runtime);
  expect(c).toContain("./sample-app");
  expect(c).toContain("Do NOT re-scaffold");
});

test("a non-coding turn gets no grounding reminder", async () => {
  await makeSubdirProject();
  const runtime = makeRuntime();
  await runtime.runTurn("s1", "what does this app do?", new AbortController().signal);
  expect(lastUserContent(runtime)).not.toContain("re-scaffold");
});

test("a fresh-project turn gets no grounding reminder", async () => {
  const runtime = makeRuntime();
  await runtime.runTurn("s1", "add a settings page", new AbortController().signal);
  expect(lastUserContent(runtime)).not.toContain("re-scaffold");
});

test("a cwd-project turn gets no grounding reminder (subdir-only policy)", async () => {
  await writeFile(join(dir, "package.json"), "{}");
  const runtime = makeRuntime();
  await runtime.runTurn("s1", "add a settings page", new AbortController().signal);
  expect(lastUserContent(runtime)).not.toContain("re-scaffold");
});
