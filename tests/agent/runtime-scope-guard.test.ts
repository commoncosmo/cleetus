import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-scope-rt-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeWriteFile(): Tool {
  return {
    name: "write_file",
    description: "",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
    mutates: true,
    serialize: (a) => `write ${(a as { path?: string }).path}`,
    run: async (a): Promise<ToolResult> => {
      const { path, content } = a as { path: string; content: string };
      const abs = resolve(dir, path);
      const before = (await Bun.file(abs).exists()) ? await Bun.file(abs).text() : "";
      await Bun.write(abs, content);
      return { ok: true, output: "written", diff: { path: abs, before, after: content } };
    },
  };
}

class ScriptedProvider implements Provider {
  calls = 0;
  constructor(private script: Array<{ name: string; args: Record<string, unknown> }>) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_opts: ChatOptions): AsyncGenerator<StreamEvent> {
    const step = this.script[this.calls];
    this.calls++;
    if (!step) {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop" };
      return;
    }
    yield { type: "tool-call", call: { id: `c${this.calls}`, name: step.name, args: step.args } };
    yield { type: "finish", reason: "tool-calls", usage: { input: 10, output: 0 }, model: "m" };
  }
  async embed() {
    return [0];
  }
}

function makeRuntime(provider: Provider, opts: Partial<AgentRuntimeOptions> = {}): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("p", provider);
  const tools = new ToolRegistry();
  tools.register(makeWriteFile());
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 20,
    guardPendingScope: () => true,
    pendingTaskTitles: () => ["Build the Settings page"],
    ...opts,
  });
}

test("worker write_file of a NEW file matching a pending title is blocked; disk unchanged", async () => {
  const abs = join(dir, "SettingsPage.tsx");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "SettingsPage.tsx", content: "PENDING" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn(
    "s1",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "Scaffold",
  );
  expect(await Bun.file(abs).exists()).toBe(false);
});

test("a NEW file matching the CURRENT task title is allowed (current wins)", async () => {
  const abs = join(dir, "SettingsPage.tsx");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "SettingsPage.tsx", content: "MINE" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn(
    "s2",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "Build the Settings page",
  );
  expect(await Bun.file(abs).text()).toBe("MINE");
});

test("a NEW file matching NO pending title is allowed (forward build)", async () => {
  const abs = join(dir, "Dashboard.tsx");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "Dashboard.tsx", content: "OK" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn(
    "s3",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "Scaffold",
  );
  expect(await Bun.file(abs).text()).toBe("OK");
});

test("a focused worker cannot overwrite unowned package infrastructure", async () => {
  const abs = join(dir, "package.json");
  await Bun.write(abs, '{"name":"original"}');
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "package.json", content: '{"name":"drift"}' } },
  ]);
  const runtime = makeRuntime(provider, {
    workerOwnedPaths: () => ["src/insights/analyzers/plan-churn.ts"],
  });
  await runtime.runTurn(
    "protected",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "Implement plan churn analyzer",
  );
  expect(await Bun.file(abs).text()).toBe('{"name":"original"}');
  expect(
    log
      .query("protected")
      .some(
        (event) =>
          event.type === "notice" && (event.payload as { kind?: string }).kind === "scope_guard",
      ),
  ).toBe(true);
});

test("a focused worker may edit explicitly owned package infrastructure", async () => {
  const abs = join(dir, "package.json");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "package.json", content: '{"name":"owned"}' } },
  ]);
  const runtime = makeRuntime(provider, { workerOwnedPaths: () => ["package.json"] });
  await runtime.runTurn(
    "owned",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "Update dependencies",
  );
  expect(await Bun.file(abs).text()).toBe('{"name":"owned"}');
});

test("guardPendingScope false → a pending-matching NEW write is allowed", async () => {
  const abs = join(dir, "SettingsPage.tsx");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "SettingsPage.tsx", content: "OFF" } },
  ]);
  const runtime = makeRuntime(provider, { guardPendingScope: () => false });
  await runtime.runTurn(
    "s4",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "Scaffold",
  );
  expect(await Bun.file(abs).text()).toBe("OFF");
});

test("a non-worker (user) session is NOT scope-guarded", async () => {
  const abs = join(dir, "SettingsPage.tsx");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "SettingsPage.tsx", content: "USER" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn("s5", "go", new AbortController().signal, "user", "Scaffold");
  expect(await Bun.file(abs).text()).toBe("USER");
});

test("control metadata is protected even in a normal user-driven turn", async () => {
  const abs = join(dir, ".cleetus", "sessions.db");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: ".cleetus/sessions.db", content: "destroyed" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn("control", "go", new AbortController().signal, "user", "Update state");
  expect(await Bun.file(abs).exists()).toBe(false);
  expect(
    log
      .query("control")
      .some(
        (event) =>
          event.type === "notice" &&
          (event.payload as { text?: string }).text?.includes("control-metadata mutation"),
      ),
  ).toBe(true);
});

test("absolute in-project path is matched on its project-relative form (dir segments don't false-block)", async () => {
  // dir's absolute path contains "cleetus-scope-rt-…"; a pending title distinctive on "scope" must
  // NOT block a normal in-project write when the model emits an ABSOLUTE path — the guard must
  // tokenize the project-RELATIVE path, not the raw absolute one.
  const abs = join(dir, "App.tsx");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: abs, content: "OK" } }, // absolute path arg
  ]);
  const runtime = makeRuntime(provider, { pendingTaskTitles: () => ["Refactor the scope guard"] });
  await runtime.runTurn(
    "sabs",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "Scaffold",
  );
  expect(await Bun.file(abs).text()).toBe("OK"); // written, not falsely blocked
});
