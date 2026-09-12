import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { DEFAULT_CONTEXT } from "../../src/config/context";
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
import { ReadFileTool } from "../../src/tools/read-file";
import { ToolRegistry } from "../../src/tools/registry";

/** Reads the SAME path according to a per-chat-call script ("read" emits a read_file tool
 *  call; "stop" finishes). Captures the messages replayed on each call. Mirrors the helper
 *  in runtime-read-elide.test.ts. */
class ScriptedReadProvider implements Provider {
  calls = 0;
  lastMessages: Message[] = [];
  constructor(
    private readonly path: string,
    private readonly script: ("read" | "stop")[],
  ) {}
  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "m" }];
  }
  async *chat(opts: ChatOptions): AsyncGenerator<StreamEvent> {
    this.lastMessages = opts.messages;
    const action = this.script[this.calls] ?? "stop";
    this.calls++;
    if (action === "read") {
      yield {
        type: "tool-call",
        call: { id: `c${this.calls}`, name: "read_file", args: { path: this.path } },
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

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-kv-prefix-"));
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
  tools.register(new ReadFileTool());
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
    context: () => ({ ...DEFAULT_CONTEXT }),
  });
}

test("a byte-identical duplicate read leaves the earlier deep-history copy untouched (KV prefix stability)", async () => {
  const path = join(dir, "f.ts");
  const CONTENT_A = `PREFIX_STABLE_TOKEN\n${"a".repeat(150)}\n`;
  const CONTENT_B = `CHANGED_BODY_TOKEN\n${"b".repeat(150)}\n`;
  await writeFile(path, CONTENT_A);
  // Turns 1-3 each read then stop (two chat calls per turn); turn 4 just stops and
  // captures the final replayed history.
  const provider = new ScriptedReadProvider(path, [
    "read",
    "stop",
    "read",
    "stop",
    "read",
    "stop",
    "stop",
  ]);
  const runtime = makeRuntime(provider);

  await runtime.runTurn("S", "read it (turn 1)"); // reads A
  await writeFile(path, CONTENT_B);
  await runtime.runTurn("S", "read it again (turn 2)"); // reads B — changed, so not elided
  await writeFile(path, CONTENT_A);
  await runtime.runTurn("S", "read it once more (turn 3)"); // reads A — differs from B, so
  // not elided: history now holds TWO byte-identical full copies (turn 1 and turn 3)
  await runtime.runTurn("S", "wrap up (turn 4)"); // stop — captures replayed history

  const toolMsgs = provider.lastMessages.filter((m) => m.role === "tool");
  expect(toolMsgs.length).toBe(3);
  // The EARLIER copy must stay byte-identical: stubbing it would mutate the prompt prefix
  // at an early index mid-session, invalidating the server's KV cache from that point.
  expect(toolMsgs[0]!.content).toContain("PREFIX_STABLE_TOKEN");
  expect(toolMsgs[2]!.content).toContain("PREFIX_STABLE_TOKEN");
  for (const m of provider.lastMessages) {
    expect(m.content ?? "").not.toContain("identical re-read");
  }
});
