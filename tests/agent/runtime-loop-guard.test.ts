import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIGEST_SYSTEM_PROMPT } from "../../src/agent/context/digest";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_LOOP_GUARD, type LoopGuardConfig } from "../../src/config/loop-guard";
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
import type { Tool, ToolResult } from "../../src/tools/types";

/** Emits edit_file on the SAME path for `editSteps` consecutive steps, then stops.
 *  Captures the messages replayed on the final call so the test can inspect the
 *  tool-result history (where the loop warning is appended). */
class RepeatEditProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  constructor(private readonly editSteps: number) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.lastMessages = opts.messages;
    if (this.calls <= this.editSteps) {
      yield {
        type: "tool-call",
        call: {
          id: `c${this.calls}`,
          name: "edit_file",
          args: { path: "same.ts", old: "a", new: "b" },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    }
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

/** Emits a `bash` tool_call with the SAME command for `bashSteps` consecutive steps,
 *  then stops. Mirrors RepeatEditProvider, capturing the final replayed messages. */
class RepeatBashProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  constructor(
    private readonly bashSteps: number,
    private readonly command: string,
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    this.lastMessages = opts.messages;
    if (this.calls <= this.bashSteps) {
      yield {
        type: "tool-call",
        call: {
          id: `c${this.calls}`,
          name: "bash",
          args: { command: this.command },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
    } else {
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "stop" };
    }
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

class NumberedProbeProvider implements Provider {
  calls = 0;
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(): AsyncGenerator<StreamEvent> {
    this.calls++;
    yield {
      type: "tool-call",
      call: {
        id: `probe${this.calls}`,
        name: "bash",
        args: {
          command: `document.dispatchEvent(ev); console.log('replay${this.calls}:', result)`,
        },
      },
    };
    yield { type: "finish", reason: "tool-calls" };
  }
  async embed(): Promise<number[]> {
    return [0];
  }
}

const editFile: Tool = {
  name: "edit_file",
  description: "",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
  },
  mutates: true,
  serialize: () => "edit_file: same.ts",
  run: async (): Promise<ToolResult> => ({
    ok: true,
    output: "edited",
    diff: { path: "same.ts", before: "a", after: "b" },
  }),
};

/** A `bash` tool whose every dispatch FAILS — the loop guard's `cmd:` rule only warns
 *  when every windowed occurrence has ok === false. */
const failingBash: Tool = {
  name: "bash",
  description: "",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
  },
  mutates: true,
  serialize: (args) => `bash: ${(args as { command?: string }).command ?? ""}`,
  run: async (): Promise<ToolResult> => ({
    ok: false,
    errorMessage: "build failed",
  }),
};

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-loopguard-rt-"));
  log = new EventLog(join(dir, "events.db"));
});

afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(
  provider: Provider,
  loopGuard?: () => LoopGuardConfig,
  maxToolLoops: number | (() => number) = 20,
  bashTool: Tool = failingBash,
  extraTools: Tool[] = [],
): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(editFile);
  tools.register(bashTool);
  for (const tool of extraTools) tools.register(tool);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops,
    loopGuard,
  });
}

test("an Air-style repair stops a rotation through unchanged files across batches and compaction", async () => {
  // Ornith read the same modules in different batches, interleaved with inventory commands.
  // No single path repeats four times in the guard's 12-call window.
  const paths = Array.from({ length: 16 }, (_, i) => `src/module-${i}.ts`);
  const reads = (indices: number[]) =>
    indices.map((i) => ({
      name: "read_file",
      args: { path: paths[i] },
    }));
  const batches = [
    reads([0, 1, 2, 3]),
    reads([4, 5, 6, 7]),
    reads([8, 9, 10, 11]),
    reads([12, 13, 14, 15]),
    [...reads([2, 4, 6, 8]), { name: "bash", args: { command: "cd src && ls -1 | sort" } }],
    [...reads([10, 12, 14, 0]), { name: "bash", args: { command: "find src -maxdepth 1 | sort" } }],
    reads([1, 3, 5, 7]),
    reads([9, 11, 13, 15]),
  ];
  let rounds = 0;
  let warningSeen = false;
  const provider: Provider = {
    listModels: async () => [{ id: "m" }],
    embed: async () => [0],
    async *chat(opts) {
      if (opts.messages[0]?.content === DIGEST_SYSTEM_PROMPT) {
        yield { type: "text-delta", text: "Earlier module contents were inspected." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      warningSeen ||= opts.messages.some((msg) =>
        msg.content.includes("Repeated inspections are returning"),
      );
      const batch = batches[rounds++];
      if (!batch) {
        yield { type: "text-delta", text: "Still looking." };
        yield { type: "finish", reason: "stop" };
        return;
      }
      for (const [i, call] of batch.entries()) {
        yield { type: "tool-call", call: { ...call, id: `round-${rounds}-${i}` } };
      }
      yield { type: "finish", reason: "tool-calls" };
    },
  };
  const runtime = makeRuntime(
    provider,
    () => DEFAULT_LOOP_GUARD,
    Number.POSITIVE_INFINITY,
    { ...failingBash, run: async () => ({ ok: true, output: paths.join("\n") }) },
    [
      {
        name: "read_file",
        description: "",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        serialize: () => "read source",
        run: async (args) => ({
          ok: true,
          output: `// ${(args as { path: string }).path}\n${"export const sample = true;\n".repeat(190)}`,
        }),
      },
    ],
  );

  const result = await runtime.runTurn("S", "Finish the existing Scwrote site now.");
  expect(result.stoppedReason).toBe("no_progress");
  expect(warningSeen).toBe(true);
  expect(rounds).toBe(6);
  expect(log.query("S").some((event) => event.type === "compaction_end")).toBe(true);
  const messages = runtime.getMessages("S");
  const requested = messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id));
  expect(
    messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
  ).toEqual(requested);
});

test("repeated successful numbered probes stop with recovery advice after warning", async () => {
  const provider = new NumberedProbeProvider();
  const bashTool: Tool = {
    ...failingBash,
    run: async (args): Promise<ToolResult> => {
      const command = (args as { command: string }).command;
      const label = command.match(/replay\d+/)?.[0];
      return { ok: true, output: `${label}: {"after":"Copy install command"}` };
    },
  };
  const runtime = makeRuntime(provider, () => DEFAULT_LOOP_GUARD, 30, bashTool);
  const result = await runtime.runTurn("S", "diagnose copy button");

  expect(provider.calls).toBe(16);
  expect(result.stoppedReason).toBe("no_progress");
  expect(result.assistantText).toContain("Save the original clicked element");
  expect(result.assistantText).toContain("Existing work is preserved");
  expect(
    log
      .query("S")
      .filter(
        (e) =>
          e.type === "notice" && (e.payload as { kind?: string }).kind === "repeated_probe_warning",
      ).length,
  ).toBe(1);
});

test("read-only package.json inspections warn and stop even when every command differs", async () => {
  let rounds = 0;
  let warningSeen = false;
  const path = "scwrote-site/package.json";
  const provider: Provider = {
    listModels: async () => [{ id: "m" }],
    embed: async () => [0],
    async *chat(opts) {
      warningSeen ||= opts.messages.some((message) =>
        message.content.includes("Repeated inspections are returning"),
      );
      const n = ++rounds;
      const commands = [
        `head -${n} ${path}`,
        `sed -n '1,${n}p' ${path}`,
        `cat ${path} | head -${n}`,
      ];
      for (const [i, command] of commands.entries()) {
        yield {
          type: "tool-call",
          call: { id: `round-${n}-${i}`, name: "bash", args: { command } },
        };
      }
      yield { type: "finish", reason: "tool-calls" };
    },
  };
  const bash = {
    ...failingBash,
    run: async () => ({ ok: true as const, output: '{"name":"scwrote-site"}' }),
  };
  const runtime = makeRuntime(provider, () => DEFAULT_LOOP_GUARD, 5, bash);
  const result = await runtime.runTurn(
    "S",
    "Inspect scwrote-site/package.json using the different read-only commands and report what ran.",
  );

  expect(result.stoppedReason).toBe("no_progress");
  expect(warningSeen).toBe(true);
  expect(rounds).toBeLessThan(5);
  expect(log.query("S").filter((event) => event.type === "notice")).toContainEqual(
    expect.objectContaining({
      payload: expect.objectContaining({ kind: "inspection_loop_warning" }),
    }),
  );
});

test("repeated edits past threshold inject ONE loop-warning and log a loop_guard notice", async () => {
  // DEFAULT_LOOP_GUARD.editRepeatThreshold = 5; drive a few steps past it.
  const provider = new RepeatEditProvider(7);
  const runtime = makeRuntime(provider, () => DEFAULT_LOOP_GUARD);
  await runtime.runTurn("S", "go");

  // The final replayed prompt carries the full tool-result history.
  const toolResults = provider.lastMessages.filter((m) => m.role === "tool");
  const warned = toolResults.filter((m) => (m.content ?? "").includes("<loop-warning>"));
  // Cooldown (6) suppresses re-warning the same signature within the window, so exactly one.
  expect(warned.length).toBe(1);

  const notices = log
    .query("S")
    .filter((e) => e.type === "notice" && (e.payload as { kind?: string }).kind === "loop_guard");
  expect(notices.length).toBe(1);
});

test("repeated failing command past threshold injects ONE loop-warning and logs a loop_guard notice", async () => {
  // DEFAULT_LOOP_GUARD.failRepeatThreshold = 3, cooldown = 6. Five consecutive failing
  // `cargo build` calls → warn at call 3; calls 4-5 suppressed by cooldown → exactly one.
  const provider = new RepeatBashProvider(5, "cargo build");
  const runtime = makeRuntime(provider, () => DEFAULT_LOOP_GUARD);
  await runtime.runTurn("S", "go");

  // The final replayed prompt carries the full tool-result history.
  const toolResults = provider.lastMessages.filter((m) => m.role === "tool");
  const warned = toolResults.filter((m) => (m.content ?? "").includes("<loop-warning>"));
  expect(warned.length).toBe(1);
  expect(warned[0]?.content ?? "").toContain("cargo build");

  const notices = log
    .query("S")
    .filter((e) => e.type === "notice" && (e.payload as { kind?: string }).kind === "loop_guard");
  expect(notices.length).toBe(1);
});

test("with loop_guard disabled, no warning is ever appended", async () => {
  const provider = new RepeatEditProvider(7);
  const runtime = makeRuntime(provider, () => ({ ...DEFAULT_LOOP_GUARD, enabled: false }));
  await runtime.runTurn("S", "go");

  const anyWarned = provider.lastMessages.some((m) => (m.content ?? "").includes("<loop-warning>"));
  expect(anyWarned).toBe(false);
  const notices = log
    .query("S")
    .filter((e) => e.type === "notice" && (e.payload as { kind?: string }).kind === "loop_guard");
  expect(notices.length).toBe(0);
});

test("honors maxToolLoops passed as an accessor", async () => {
  const holder = { value: 1 };
  // RepeatEditProvider(999) always returns a tool call — the main loop would run up to
  // 999 times if the accessor were ignored and the cap fell back to some larger default.
  const provider = new RepeatEditProvider(999);
  const runtime = makeRuntime(provider, undefined, () => holder.value);
  await runtime.runTurn("S", "go");

  // One exact model round proves the accessor's cap was honored without a synthesis call.
  expect(provider.calls).toBe(1);
});

test("still honors maxToolLoops passed as a plain number (back-compat)", async () => {
  const provider = new RepeatEditProvider(999);
  const runtime = makeRuntime(provider, undefined, 1);
  await runtime.runTurn("S", "go");

  expect(provider.calls).toBe(1);
});
