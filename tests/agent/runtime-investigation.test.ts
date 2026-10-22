import { afterEach, describe, expect, it } from "bun:test";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime, type AgentRuntimeOptions } from "../../src/agent/runtime";
import { DEFAULT_CONTEXT } from "../../src/config/context";
import { EventLog } from "../../src/events/log";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions, Message, Provider, StreamEvent } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { InvestigationNotesTool } from "../../src/tools/investigation-notes";
import { ToolRegistry } from "../../src/tools/registry";
import type { Tool } from "../../src/tools/types";

const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
});
function runtime(
  chat: Provider["chat"],
  extra: Tool[] = [],
  options: Partial<AgentRuntimeOptions> = {},
) {
  const providers = new ProviderRegistry();
  providers.register("local", {
    listModels: async () => [{ id: "model" }],
    embed: async () => [1],
    chat,
  });
  const tools = new ToolRegistry();
  for (const tool of extra) tools.register(tool);
  const log = new EventLog(":memory:");
  logs.push(log);
  const agent = new AgentRuntime({
    providers,
    tools,
    log,
    dispatcher: new ToolDispatcher(tools),
    router: staticRouter({ provider: "local", model: "model" }),
    systemPrompt: () => "System",
    projectDir: "/tmp",
    maxToolLoops: 25,
    resolvePermission: async () => "allow",
    ...options,
  });
  return { agent, log };
}

describe("investigation runtime", () => {
  it("ends a varied-shell reread loop with evidence synthesis instead of requiring edits", async () => {
    const requests: ChatOptions[] = [];
    const commands = [
      "cat src/a.ts",
      "cat -n src/a.ts",
      "sed -n '1,50p' src/a.ts",
      "head -50 src/a.ts",
      "cat ./src/a.ts",
      "sed -n '1,49p' ./src/a.ts",
    ];
    const body = Array.from({ length: 40 }, (_, i) => `const item${i} = { value: ${i} };`).join(
      "\n",
    );
    let round = 0;
    const bash: Tool = {
      name: "bash",
      description: "read source",
      parameters: {},
      serialize: () => "read source",
      run: async () => ({ ok: true, output: body }),
    };
    const browser: Tool = {
      ...bash,
      name: "mcp__playwright__browser_snapshot",
      description: "Browser schema ".repeat(1000),
    };
    const { agent, log } = runtime(
      async function* (request): AsyncGenerator<StreamEvent> {
        requests.push(request);
        if (!request.tools?.length) {
          yield {
            type: "text-delta",
            text: "The budget is capped. Evidence: src/a.ts. Further performance validation remains unresolved.",
          };
          yield { type: "finish", reason: "stop" };
          return;
        }
        yield {
          type: "tool-call",
          call: {
            id: `r${round}`,
            name: "bash",
            args: { command: commands[round++ % commands.length] },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
      },
      [bash, browser],
    );
    const result = await agent.runTurn(
      "review",
      "Take a look at context management in this codebase and recommend improvements.",
    );
    expect(result.assistantText).toContain("Evidence: src/a.ts");
    expect(round).toBe(5);
    expect(requests[0]!.tools?.some((tool) => tool.name === browser.name)).toBe(false);
    expect(requests[0]!.tools?.some((tool) => tool.name === "investigation_notes")).toBe(true);
    expect(
      log
        .query("review")
        .filter(
          (event) =>
            event.type === "notice" &&
            (event.payload as { kind?: string }).kind === "investigation_checkpoint",
        ),
    ).toHaveLength(2);
  });

  it("retains a bounded evidence notebook after compaction and a restored session", async () => {
    const notes = await new InvestigationNotesTool().run({
      findings: [
        { summary: "History budget is capped", evidence: "src/agent/context/budget.ts:48" },
      ],
      ruled_out: ["database corruption"],
      open_questions: ["measure latency at a larger confirmed budget"],
    });
    const history: Message[] = [
      { role: "user", content: "Review context management" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "notes", name: "investigation_notes", args: {} }],
      },
      { role: "tool", toolCallId: "notes", content: notes.output! },
      ...Array.from({ length: 20 }, () => ({
        role: "assistant" as const,
        content: "old unrelated evidence ".repeat(80),
      })),
    ];
    const requests: ChatOptions[] = [];
    const chat: Provider["chat"] = async function* (request) {
      requests.push(request);
      yield { type: "text-delta", text: "Generic summary without specific findings." };
      yield { type: "finish", reason: "stop" };
    };
    const options = {
      context: () => ({ ...DEFAULT_CONTEXT, budgetTokens: 6000, maxBudgetTokens: 6000 }),
    };
    const first = runtime(chat, [], options).agent;
    first.loadSession("review", history, []);
    expect((await first.compactNow("review")).compacted).toBe(true);
    await first.runTurn("review", "Report your findings.");
    expect(
      requests
        .at(-1)!
        .messages.map((message) => message.content)
        .join("\n"),
    ).toContain("History budget is capped");
    expect(
      requests
        .at(-1)!
        .messages.map((message) => message.content)
        .join("\n"),
    ).toContain("database corruption");
    const restored = runtime(chat, [], options).agent;
    restored.loadSession("review", first.getMessages("review"), []);
    await restored.runTurn("review", "Continue the review.");
    expect(
      requests
        .at(-1)!
        .messages.map((message) => message.content)
        .join("\n"),
    ).toContain("src/agent/context/budget.ts:48");
    expect(restored.getContextBudget("review")!.evidenceTokens!).toBeGreaterThan(50);
  });

  it("does not activate review constraints or hide browsers for implementation requests", async () => {
    let request: ChatOptions | undefined;
    const browser: Tool = {
      name: "mcp__playwright__browser_snapshot",
      description: "browser",
      parameters: {},
      serialize: () => "browser",
      run: async () => ({ ok: true }),
    };
    const { agent } = runtime(
      async function* (input) {
        request = input;
        yield { type: "text-delta", text: "Ready." };
        yield { type: "finish", reason: "stop" };
      },
      [browser],
    );
    await agent.runTurn("work", "Explain the implementation of the context code.");
    expect(request!.tools?.some((tool) => tool.name === browser.name)).toBe(true);
    expect(request!.tools?.some((tool) => tool.name === "investigation_notes")).toBe(false);
  });
});
