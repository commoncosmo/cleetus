import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { type ContextConfig, DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool, ToolResult } from "../../src/tools/types";

let ran = 0;
const stubWrite: Tool = {
  name: "write_file",
  description: "",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
  mutates: true,
  serialize: () => "write_file",
  run: async (): Promise<ToolResult> => {
    ran++;
    return { ok: true, output: "wrote" };
  },
};

/** Turn 1: a write_file call to `badPath`. Turn 2+: a clean final answer. */
class WriteProvider implements Provider {
  public calls = 0;
  constructor(private readonly badPath: string) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async *chat(_req: ChatOptions): AsyncGenerator<StreamEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield {
        type: "tool-call",
        call: { id: "c1", name: "write_file", args: { path: this.badPath, content: "x" } },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "done" };
    yield { type: "finish", reason: "stop" };
  }
  async embed() {
    return [0];
  }
}

let dir: string;
let log: EventLog;
let permChecks: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-malformed-"));
  await mkdir(join(dir, "src"));
  log = new EventLog(join(dir, "events.db"));
  ran = 0;
  permChecks = 0;
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function makeRuntime(provider: Provider, enabled: boolean): AgentRuntime {
  const context: ContextConfig = { ...DEFAULT_CONTEXT };
  const providers = new ProviderRegistry();
  providers.register("lm", provider);
  const tools = new ToolRegistry();
  tools.register(stubWrite);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "lm", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => {
      permChecks++;
      return "allow";
    },
    maxToolLoops: 5,
    context: () => context,
    malformedPath: () => ({ enabled }),
  });
}

// An ESCAPING near-miss: a sibling dir `x <projectBasename>` (space-injected, like the
// forensic `f sample-app`), with the real `<dir>/src` existing → recovers `<dir>/src/App.tsx`.
function badPath(dir: string): string {
  return `${dirname(dir)}/x ${basename(dir)}/src/App.tsx`;
}

describe("AgentRuntime malformed-path rejection (#106)", () => {
  it("rejects a malformed write path before prompt + dispatch, with a suggestion", async () => {
    const provider = new WriteProvider(badPath(dir));
    const runtime = makeRuntime(provider, true);
    await runtime.runTurn("S", "write it");

    expect(ran).toBe(0); // dispatcher.run never called
    expect(permChecks).toBe(0); // resolvePermission never called
    const errs = log.query("S").filter((e) => e.type === "error");
    const msg = errs.map((e) => (e.payload as { message: string }).message).join("\n");
    expect(msg).toContain("malformed path");
    expect(msg).toContain(join(dir, "src/App.tsx"));
  });

  it("disabled → the same call reaches resolvePermission", async () => {
    const provider = new WriteProvider(badPath(dir));
    const runtime = makeRuntime(provider, false);
    await runtime.runTurn("S", "write it");
    expect(permChecks).toBeGreaterThan(0); // permission was consulted
  });
});
