import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticRouter } from "../../src/agent/router";
import { AgentRuntime } from "../../src/agent/runtime";
import { EventLog } from "../../src/events/log";
import { chatOpenAI } from "../../src/providers/openai-compat";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ChatOptions } from "../../src/providers/types";
import { ToolDispatcher } from "../../src/tools/dispatcher";
import { ToolRegistry } from "../../src/tools/registry";
import { WriteFileTool } from "../../src/tools/write-file";

const originalFetch = globalThis.fetch;
let dir: string;
let log: EventLog;
let requests: ChatOptions[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-stream-disconnect-"));
  log = new EventLog(join(dir, "events.db"));
  requests = [];
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  log.close();
  await rm(dir, { recursive: true, force: true });
});

function frame(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}

function writeResponse(id: string, path: string): Response {
  return new Response(
    `${frame(
      {
        tool_calls: [
          {
            index: 0,
            id,
            function: { name: "write_file", arguments: JSON.stringify({ path, content: path }) },
          },
        ],
      },
      "tool_calls",
    )}data: [DONE]\n\n`,
  );
}

function disconnectedResponse(onDisconnect?: () => void): Response {
  let pulls = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (pulls++ === 0)
          controller.enqueue(
            new TextEncoder().encode(
              frame({
                reasoning_content: "Preparing another file",
                content: "Partial response that must not become the final answer.",
                tool_calls: [
                  {
                    index: 0,
                    id: "partial",
                    function: { name: "write_file", arguments: '{"path":' },
                  },
                ],
              }),
            ),
          );
        else {
          onDisconnect?.();
          controller.error(new Error("The socket connection was closed unexpectedly."));
        }
      },
    }),
  );
}

function runtime(): AgentRuntime {
  const providers = new ProviderRegistry();
  providers.register("mock", {
    listModels: async () => [{ id: "m" }],
    embed: async () => [],
    chat: (request) => {
      requests.push(structuredClone({ ...request, signal: undefined }));
      return chatOpenAI({ baseUrl: "http://mock.invalid" }, request);
    },
  });
  const tools = new ToolRegistry();
  tools.register(new WriteFileTool());
  return new AgentRuntime({
    providers,
    tools,
    dispatcher: new ToolDispatcher(tools),
    log,
    router: staticRouter({ provider: "mock", model: "m" }),
    systemPrompt: () => "",
    projectDir: dir,
    resolvePermission: async () => "allow",
    maxToolLoops: 8,
    suggestLearnedPlaybook: true,
  });
}

test("retries a disconnected stream once without replaying completed or partial writes", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    switch (++calls) {
      case 1:
        return writeResponse("before", "before.ts");
      case 2:
        return disconnectedResponse();
      case 3:
        return writeResponse("after", "after.ts");
      default:
        return new Response(frame({ content: "Finished both files." }, "stop"));
    }
  }) as unknown as typeof fetch;
  const result = await runtime().runTurn("session", "Write the files");
  expect(calls).toBe(4);
  expect(result.assistantText).toBe("Finished both files.");
  expect(result.stoppedReason).toBeUndefined();
  expect(await readFile(join(dir, "before.ts"), "utf8")).toBe("before.ts");
  expect(await readFile(join(dir, "after.ts"), "utf8")).toBe("after.ts");
  const writes = log.query("session").filter((event) => event.type === "tool_call_start");
  expect(writes.map((event) => (event.payload as { call: { id: string } }).call.id)).toEqual([
    "before",
    "after",
  ]);
  expect(requests[2]!.messages).toEqual(requests[1]!.messages);
});

test("two disconnects stop only the turn, preserve earlier edits, and allow a new prompt", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    if (++calls === 1) return writeResponse("before", "before.ts");
    if (calls <= 3) return disconnectedResponse();
    return new Response(frame({ content: "Ready to continue." }, "stop"));
  }) as unknown as typeof fetch;
  const agent = runtime();
  const result = await agent.runTurn("session", "Write the files");
  expect(calls).toBe(3);
  expect(result.stoppedReason).toBe("provider_error");
  expect(result.assistantText).toContain("connection failed repeatedly");
  expect(await readFile(join(dir, "before.ts"), "utf8")).toBe("before.ts");
  const events = log.query("session");
  expect(events.filter((event) => event.type === "tool_call_start")).toHaveLength(1);
  expect(
    events.some(
      (event) =>
        event.type === "notice" &&
        (event.payload as { kind?: string }).kind === "learn_playbook_suggestion",
    ),
  ).toBe(false);
  expect(
    events.filter((event) => event.type === "assistant_message").at(-1)?.payload,
  ).toMatchObject({
    stoppedReason: "provider_error",
  });
  const next = await agent.runTurn("session", "Continue");
  expect(next.assistantText).toBe("Ready to continue.");
  expect(calls).toBe(4);
});

test("cancelling during a failed read does not retry", async () => {
  const abort = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return disconnectedResponse(() => abort.abort());
  }) as unknown as typeof fetch;
  const result = await runtime().runTurn("session", "Write the files", abort.signal);
  expect(result.stoppedReason).toBe("cancelled");
  expect(calls).toBe(1);
  expect(log.query("session").some((event) => event.type === "tool_call_start")).toBe(false);
});
