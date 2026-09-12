import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { type ContextConfig, DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

/** A minimal `bash`-like tool so the main loop sends a tool schema (req.tools is
 *  non-empty), which both drives the tool round-trip and lets the fake provider tell a
 *  main call apart from the tool-less finish pass. */
const stubBash: Tool = {
  name: "bash",
  description: "",
  parameters: { type: "object", properties: { command: { type: "string" } } },
  mutates: true,
  serialize: (args) => `bash: ${(args as { command?: string }).command ?? ""}`,
  run: async (): Promise<ToolResult> => ({ ok: true, output: "ok" }),
};

/** Provider whose main turns keep calling a tool. It records whether cap handling makes an
 *  additional model call; the runtime must now own the incomplete checkpoint itself. */
class CapThenFinishProvider implements Provider {
  calls = 0;
  constructor(private readonly finishText: string[]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (req.tools && req.tools.length > 0) {
      yield { type: "tool-call", call: { id: "c1", name: "bash", args: { command: "echo hi" } } };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    for (const t of this.finishText) yield { type: "text-delta", text: t };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-finish-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(provider: Provider, maxToolLoops: number): AgentRuntime {
  const context: ContextConfig = { ...DEFAULT_CONTEXT };
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(stubBash);
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
    context: () => context,
  });
}

const STEP_NOTE_RE =
  /Paused incomplete after reaching the explicit \d+-round safety limit.*Reply 'continue'.*\/maxloops unlimited/;

describe("AgentRuntime explicit loop-limit checkpoint", () => {
  it("does not ask the model to summarize after an explicit limit", async () => {
    const provider = new CapThenFinishProvider([
      "Let me start by checking the project, then I'll build a fun Tauri v2 app.\n\n",
      "<tool_call>\n<function=bash>\n<parameter=command>\nls -la /proj\n</parameter>\n</function>\n</tool_call>\n",
    ]);
    const runtime = makeRuntime(provider, 1);
    const res = await runtime.runTurn("S", "build it");
    expect(res.assistantText).toMatch(STEP_NOTE_RE);
    expect(provider.calls).toBe(1);
    expect(res.assistantText).not.toContain("<tool_call>");
    expect(res.assistantText).not.toContain("build a fun Tauri");
  });

  it("keeps the checkpoint runtime-owned even when the model could provide plausible prose", async () => {
    const provider = new CapThenFinishProvider([
      "I scaffolded tauri-desk; remaining: implement the desktop features.",
    ]);
    const runtime = makeRuntime(provider, 1);
    const res = await runtime.runTurn("S", "build it");
    expect(res.assistantText).toMatch(STEP_NOTE_RE);
    expect(res.assistantText).not.toContain("I scaffolded tauri-desk");
    expect(provider.calls).toBe(1);
  });
});
