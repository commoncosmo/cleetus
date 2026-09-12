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
import { WriteFileTool } from "../../src/tools/write-file";

let dir: string;
let log: EventLog;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "small-model-regression-"));
  log = new EventLog(join(dir, "events.db"));
});
afterEach(async () => {
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function harness(
  script: (request: ChatOptions, index: number) => StreamEvent[],
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) {
  const requests: ChatOptions[] = [];
  const provider: Provider = {
    listModels: async () => [{ id: "9b" }],
    embed: async () => [0],
    async *chat(request) {
      requests.push(request);
      yield* script(request, requests.length - 1);
    },
  };
  const providers = new ProviderRegistry();
  providers.register("local", provider);
  const tools = new ToolRegistry();
  tools.register(new WriteFileTool());
  for (const name of ["render_check", "smoke_run", "apply_patch"])
    tools.register({
      name,
      description: name,
      parameters: {},
      serialize: () => name,
      run: async () => ({ ok: true, output: "ok" }),
    });
  const runtime = new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "local", model: "9b" }),
    projectDir: dir,
    systemPrompt: () => "standard instructions",
    smallSystemPrompt: () => "small instructions",
    resolvePermission: async () => "allow",
    maxToolLoops: 50,
    context: () => ({ ...DEFAULT_CONTEXT, summarize: false }),
    ...extra,
  });
  return { runtime, requests };
}
const done: StreamEvent[] = [
  { type: "text-delta", text: "Implemented successfully." },
  { type: "finish", reason: "stop" },
];

test("audit counts rejected tools in a batch and terminates with an unresolved result", async () => {
  const { runtime, requests } = harness(
    (request, index) => {
      if (index === 0)
        return [
          {
            type: "tool-call",
            call: {
              id: "write",
              name: "write_file",
              args: { path: "app.ts", content: "export const value = 1;" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ];
      if (index === 1 || request.tools?.length === 0) return done;
      return [
        ...Array.from(
          { length: 8 },
          (_, i): StreamEvent => ({
            type: "tool-call",
            call: { id: `unknown-${i}`, name: "invented_check", args: {} },
          }),
        ),
        { type: "finish", reason: "tool-calls" },
      ];
    },
    { completionAudit: true, completionAuditLimits: { modelCalls: 6, toolAttempts: 2 } },
  );
  const result = await runtime.runTurn("s", "Implement a feature in app.ts");
  expect(requests.length).toBe(4);
  expect(result.stoppedReason).toBe("no_progress");
  expect(result.assistantText).toContain("audit exceeded 2 tool attempts");
  expect(result.assistantText).toContain("unverified");
  const history = runtime.getMessages("s");
  const batch = history.findIndex((m) => m.toolCalls?.[0]?.id === "unknown-0");
  expect(history.slice(batch + 1, batch + 9).every((m) => m.role === "tool")).toBe(true);
});

test("audit call budget closes tools even when each attempted command differs", async () => {
  const { runtime, requests } = harness(
    (request, index) => {
      if (index === 0)
        return [
          {
            type: "tool-call",
            call: {
              id: "write",
              name: "write_file",
              args: { path: "app.ts", content: "export const value = 1;" },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ];
      if (index === 1 || request.tools?.length === 0) return done;
      return [
        {
          type: "tool-call",
          call: { id: `different-${index}`, name: `invented_${index}`, args: {} },
        },
        { type: "finish", reason: "tool-calls" },
      ];
    },
    { completionAudit: true, completionAuditLimits: { modelCalls: 2, toolAttempts: 20 } },
  );
  const result = await runtime.runTurn("s", "Implement a feature in app.ts");
  expect(requests.length).toBe(5);
  expect(result.assistantText).toContain("audit exceeded 2 model calls");
  expect(result.stoppedReason).toBe("no_progress");
});

test("plan step omits old tool chatter but preserves original user corrections and recorded checks", async () => {
  const { runtime, requests } = harness(() => done);
  runtime.loadSession(
    "s",
    [
      { role: "user", content: "/spec Build a chat app" },
      { role: "user", content: "Collapse thinking when answer content starts" },
      { role: "assistant", content: "OBSOLETE_DEBUG_OUTPUT".repeat(4000) },
    ],
    [],
  );
  await runtime.runTurn(
    "s",
    "Implement step 4 of 5: thinking window",
    undefined,
    undefined,
    undefined,
    undefined,
    {
      isolatedPlanStep: true,
      completedStepEvidence: "Step 3: build passed; streaming test passed",
    },
  );
  const sent = requests[0]!.messages.map((m) => m.content).join("\n");
  expect(sent).not.toContain("OBSOLETE_DEBUG_OUTPUT");
  expect(sent).toContain("Collapse thinking when answer content starts");
  expect(sent).toContain("streaming test passed");
  expect(runtime.getMessages("s").some((m) => m.content.includes("OBSOLETE_DEBUG_OUTPUT"))).toBe(
    true,
  );
});

test("per-model small profile overrides a large served context while retaining verification tools", async () => {
  const { runtime, requests } = harness(() => done, {
    capability: () => "standard",
    modelContextLength: () => 131072,
    modelProfile: () => ({ capability: "small", max_budget_tokens: 8192 }),
  });
  runtime.loadSession(
    "s",
    [
      { role: "user", content: "previous" },
      { role: "assistant", content: "old data ".repeat(15000) },
    ],
    [],
  );
  await runtime.runTurn("s", "Fix the feature");
  expect(requests[0]!.messages[0]!.content).toBe("small instructions");
  const names = requests[0]!.tools?.map((t) => t.name);
  expect(names).toContain("render_check");
  expect(names).toContain("smoke_run");
  expect(names).not.toContain("apply_patch");
  expect(requests[0]!.messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThan(8192 * 4);
});

test("a visibility complaint cannot be closed by text-only rendering", async () => {
  const { runtime } = harness((_request, index) =>
    index === 0
      ? [
          {
            type: "tool-call",
            call: {
              id: "render",
              name: "render_check",
              args: {
                expectedText: "Chat",
                launchCommand: "bun run dev",
                url: "http://localhost:5173",
              },
            },
          },
          { type: "finish", reason: "tool-calls" },
        ]
      : done,
  );
  const result = await runtime.runTurn("s", "The prompt input is invisible");
  expect(result.assistantText).toContain("reported control visibility was not verified");
  expect(
    runtime
      .getMessages("s")
      .some((m) => m.role === "tool" && m.content.includes("requires expectedControl")),
  ).toBe(true);
});
