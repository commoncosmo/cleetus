import { afterEach, expect, test } from "bun:test";
import { chatOpenAI } from "../../../src/providers/openai-compat";
import type { ChatOptions, StreamEvent } from "../../../src/providers/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sse(...chunks: object[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

function stubFetch(body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
}

async function collect(req: ChatOptions): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of chatOpenAI({ baseUrl: "http://x" }, req)) out.push(ev);
  return out;
}

const READ_FILE = {
  name: "read_file",
  description: "",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};

test("recovers a qwen-xml tool call leaked into content", async () => {
  const leaked =
    "<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>";
  stubFetch(
    sse(
      { choices: [{ delta: { content: leaked } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ),
  );
  const events = await collect({
    model: "qwen3-coder",
    messages: [{ role: "user", content: "read it" }],
    tools: [READ_FILE],
  });
  const toolCalls = events.filter((e) => e.type === "tool-call");
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]).toMatchObject({ recovered: true, call: { name: "read_file" } });
  const finish = events.find((e) => e.type === "finish");
  expect(finish).toMatchObject({ reason: "tool-calls" });
});

test("recovers harmony call leaked into the reasoning channel with empty content", async () => {
  const leaked = '<|channel|>commentary to=functions.read_file<|message|>{"path":"a.ts"}<|call|>';
  stubFetch(
    sse(
      { choices: [{ delta: { reasoning_content: leaked } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ),
  );
  const events = await collect({
    model: "gpt-oss-20b",
    messages: [{ role: "user", content: "read it" }],
    tools: [READ_FILE],
  });
  expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
});

test("does NOT run recovery when the server already returned structured tool calls", async () => {
  stubFetch(
    sse(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ),
  );
  const events = await collect({
    model: "qwen3-coder",
    messages: [{ role: "user", content: "read it" }],
    tools: [READ_FILE],
  });
  const toolCalls = events.filter((e) => e.type === "tool-call");
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]).not.toHaveProperty("recovered", true);
});

test("model_family.enabled:false disables recovery", async () => {
  const leaked =
    "<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>";
  stubFetch(
    sse(
      { choices: [{ delta: { content: leaked } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ),
  );
  const events = await collect({
    model: "qwen3-coder",
    messages: [{ role: "user", content: "read it" }],
    tools: [READ_FILE],
    modelFamily: { enabled: false },
  });
  expect(events.filter((e) => e.type === "tool-call")).toHaveLength(0);
});

test("recovery does not overwrite a 'length' (truncation) finish reason", async () => {
  const leaked =
    "<tool_call><function=read_file><parameter=path>a.ts</parameter></function></tool_call>";
  stubFetch(
    sse(
      { choices: [{ delta: { content: leaked } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ),
  );
  const events = await collect({
    model: "qwen3-coder",
    messages: [{ role: "user", content: "read it" }],
    tools: [READ_FILE],
  });
  // The truncation signal must survive so the runtime can surface its notice and NOT
  // dispatch a call extracted from an incomplete response.
  const finish = events.find((e) => e.type === "finish");
  expect(finish).toMatchObject({ reason: "length" });
});
