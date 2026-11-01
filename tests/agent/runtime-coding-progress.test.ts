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
import type { Tool, ToolResult } from "../../src/tools/types";

class Scripted implements Provider {
  requests: ChatOptions[] = [];
  constructor(private readonly script: StreamEvent[][]) {}
  async listModels() {
    return [{ id: "m" }];
  }
  async embed() {
    return [0];
  }
  async *chat(options: ChatOptions) {
    this.requests.push(options);
    yield* this.script.shift() ?? [{ type: "finish", reason: "stop" } as StreamEvent];
  }
}
let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct4-progress-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});
const round = (id: string, name: string, args: unknown): StreamEvent[] => [
  { type: "tool-call", call: { id, name, args } },
  { type: "finish", reason: "tool-calls" },
];
function runtime(provider: Scripted, names: string[], run: (name: string) => ToolResult) {
  const providers = new ProviderRegistry();
  providers.register("test", provider);
  const tools = new ToolRegistry();
  for (const name of names)
    tools.register({
      name,
      description: name,
      parameters: { type: "object" },
      serialize: () => name,
      run: async () => run(name),
    } satisfies Tool);
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "test", model: "m" }),
    systemPrompt: () => "sys",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 15,
    context: () => ({ ...DEFAULT_CONTEXT, budgetTokens: 3000, summarize: false }),
    completionAudit: false,
  });
}

test("ct4 mixed research counts empty document calls and preserves confirmed execution state after trimming", async () => {
  const script = Array.from({ length: 10 }, (_, i) =>
    i % 2
      ? round(`r${i}`, "bash", { command: "Get-Content package.json | Out-String -Width 200" })
      : round(`r${i}`, "web_fetch", { url: "https://example.com/llms.txt", query: `guess ${i}` }),
  );
  script.push([
    { type: "text-delta", text: "Inspection finished." },
    { type: "finish", reason: "stop" },
  ]);
  const provider = new Scripted(script);
  const agent = runtime(provider, ["bash", "web_fetch"], (name) =>
    name === "web_fetch"
      ? {
          ok: true,
          output: "No matching line",
          documentation: {
            url: "https://example.com/llms.txt",
            matched: false,
            cached: true,
            totalLines: 1283,
          },
        }
      : { ok: true, output: "Template inventory\n".repeat(200) },
  );
  const result = await agent.runTurn(
    "s",
    "Create a vite/typescript site with Ripple. Content comes after scaffolding.",
  );
  expect(result.unproductiveToolCalls).toBe(5);
  expect(
    log
      .query("s")
      .some(
        (event) =>
          event.type === "notice" &&
          (event.payload as { kind?: string }).kind === "coding_progress_checkpoint",
      ),
  ).toBe(true);
  const last = provider.requests.at(-1)!.messages;
  expect(last.some((message) => message.content.includes("Confirmed writes this turn: none"))).toBe(
    true,
  );
  expect(
    last.filter((message) => message.content.includes("Content comes after scaffolding.")).length,
  ).toBe(1);
  expect(
    log
      .query("s")
      .some(
        (event) =>
          event.type === "notice" &&
          (event.payload as { text?: string }).text?.includes("Context trimmed"),
      ),
  ).toBe(true);
});

test("ct4 standalone PowerShell formatting wrappers reuse an unchanged successful build", async () => {
  const provider = new Scripted([
    round("build", "bash", { command: "npm run build 2>&1 | Out-String -Width 200" }),
    round("again", "bash", { command: "npm run build 2>&1 | Select-Object -First 60" }),
    [
      { type: "text-delta", text: "Build checks finished." },
      { type: "finish", reason: "stop" },
    ],
  ]);
  let runs = 0;
  const agent = runtime(provider, ["bash"], () => {
    runs++;
    return { ok: true, output: "build passed" };
  });
  await agent.runTurn("s", "Build the project.");
  expect(runs).toBe(1);
  expect(
    log
      .query("s")
      .filter((event) => event.type === "tool_call_end")
      .some((event) => (event.payload as { output?: string }).output?.includes('"reused":true')),
  ).toBe(true);
});
