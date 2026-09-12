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
  dir = await mkdtemp(join(tmpdir(), "cleetus-recreate-rt-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

/** write_file stub that actually writes `content` to `resolve(dir, path)` on disk. */
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

/** read_file stub returning the on-disk text. */
function makeReadFile(): Tool {
  return {
    name: "read_file",
    description: "",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    mutates: false,
    serialize: (a) => `read ${(a as { path?: string }).path}`,
    run: async (a): Promise<ToolResult> => {
      const { path } = a as { path: string };
      return { ok: true, output: await Bun.file(resolve(dir, path)).text() };
    },
  };
}

/** Emits a fixed list of tool calls, one per model call, then finishes. */
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
  tools.register(makeReadFile());
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
    protectExistingFiles: () => true,
    ...opts,
  });
}

test("worker write_file over an existing, untouched file is blocked; disk unchanged", async () => {
  const abs = join(dir, "Header.tsx");
  await Bun.write(abs, "ORIGINAL");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "Header.tsx", content: "CLOBBERED" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn("s1", "go", new AbortController().signal, "orchestration-worker", "t1");
  expect(await Bun.file(abs).text()).toBe("ORIGINAL");
});

test("after read_file, a subsequent worker write_file to that path succeeds", async () => {
  const abs = join(dir, "Header.tsx");
  await Bun.write(abs, "ORIGINAL");
  const provider = new ScriptedProvider([
    { name: "read_file", args: { path: "Header.tsx" } },
    { name: "write_file", args: { path: "Header.tsx", content: "REWRITTEN" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn("s2", "go", new AbortController().signal, "orchestration-worker", "t2");
  expect(await Bun.file(abs).text()).toBe("REWRITTEN");
});

test("worker write_file to a NEW path succeeds (forward build allowed)", async () => {
  const abs = join(dir, "NewPage.tsx");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "NewPage.tsx", content: "NEW" } },
  ]);
  const runtime = makeRuntime(provider);
  const res = await runtime.runTurn(
    "s3",
    "go",
    new AbortController().signal,
    "orchestration-worker",
    "t3",
  );
  expect(await Bun.file(abs).text()).toBe("NEW");
  // #Task2: the landed write's project-relative path is captured on the turn result, feeding
  // PlanTask.producedFiles for the next worker's "Already done" digest.
  expect(res.editedPaths).toEqual(["NewPage.tsx"]);
});

test("a non-worker (user) session is NOT blocked over the same existing file", async () => {
  const abs = join(dir, "Header.tsx");
  await Bun.write(abs, "ORIGINAL");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "Header.tsx", content: "USEREDIT" } },
  ]);
  const runtime = makeRuntime(provider);
  await runtime.runTurn("s4", "go", new AbortController().signal, "user", "t4");
  expect(await Bun.file(abs).text()).toBe("USEREDIT");
});

test("protectExistingFiles false → a worker overwrite is NOT blocked", async () => {
  const abs = join(dir, "Header.tsx");
  await Bun.write(abs, "ORIGINAL");
  const provider = new ScriptedProvider([
    { name: "write_file", args: { path: "Header.tsx", content: "CLOBBERED" } },
  ]);
  const runtime = makeRuntime(provider, { protectExistingFiles: () => false });
  await runtime.runTurn("s5", "go", new AbortController().signal, "orchestration-worker", "t5");
  expect(await Bun.file(abs).text()).toBe("CLOBBERED");
});

/**
 * apply_patch stub whose ONLY arg is `patch` (no `path`/`file_path`) — the target lives inside
 * the patch text. Actually writes `after` to disk so the flow is realistic, and returns
 * `diff.path` the way the real apply_patch tool does.
 */
function makeApplyPatch(): Tool {
  return {
    name: "apply_patch",
    description: "",
    parameters: { type: "object", properties: { patch: { type: "string" } } },
    mutates: true,
    serialize: () => "apply_patch",
    run: async (a): Promise<ToolResult> => {
      const { patch } = a as { patch: string };
      const abs = resolve(dir, "Header.tsx");
      const before = (await Bun.file(abs).exists()) ? await Bun.file(abs).text() : "";
      const after = "PATCHED";
      await Bun.write(abs, after);
      return { ok: true, output: `patched ${patch}`, diff: { path: abs, before, after } };
    },
  };
}

test("after apply_patch touches a file, a subsequent worker write_file to that path succeeds", async () => {
  const abs = join(dir, "Header.tsx");
  await Bun.write(abs, "ORIGINAL");
  const provider = new ScriptedProvider([
    {
      name: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Update File: Header.tsx\n*** End Patch" },
    },
    { name: "write_file", args: { path: "Header.tsx", content: "REWRITTEN" } },
  ]);
  const providers = new ProviderRegistry();
  providers.register("p", provider);
  const tools = new ToolRegistry();
  tools.register(makeWriteFile());
  tools.register(makeReadFile());
  tools.register(makeApplyPatch());
  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "p", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 20,
    protectExistingFiles: () => true,
  });
  await runtime.runTurn("s6", "go", new AbortController().signal, "orchestration-worker", "t6");
  expect(await Bun.file(abs).text()).toBe("REWRITTEN");
});
