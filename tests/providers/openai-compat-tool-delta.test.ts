import { afterEach, describe, expect, it } from "bun:test";
import { chatOpenAI } from "../../src/providers/openai-compat";
import type { ChatOptions, StreamEvent } from "../../src/providers/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stub fetch to return a streamed tool call whose arguments arrive across two chunks. */
function stubToolCallStream(): void {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"write_file","arguments":""}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\",\\"content\\":\\"hi\\"}"}}]}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    "data: [DONE]\n\n";
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    )) as unknown as typeof fetch;
}

async function collect(req: ChatOptions): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of chatOpenAI({ baseUrl: "http://x" }, req)) out.push(ev);
  return out;
}

describe("chatOpenAI tool-call-delta heartbeats", () => {
  it("yields tool-call-delta as arguments accumulate, before the complete tool-call", async () => {
    stubToolCallStream();
    const events = await collect({ model: "m", messages: [{ role: "user", content: "hi" }] });

    const deltaIdx = events.findIndex((e) => e.type === "tool-call-delta");
    const callIdx = events.findIndex((e) => e.type === "tool-call");
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(deltaIdx);

    const deltas = events.filter((e) => e.type === "tool-call-delta");
    expect(deltas.every((d) => (d as { index: number }).index === 0)).toBe(true);

    const call = events.find((e) => e.type === "tool-call") as { call: { args: unknown } };
    expect(call.call.args).toEqual({ path: "a.txt", content: "hi" });
  });

  it("accepts llama.cpp tool-call arguments that are already decoded objects", async () => {
    const sse = `${[
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: { path: "a.txt" } } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
      "data: [DONE]",
    ].join("\n\n")}\n\n`;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
      )) as unknown as typeof fetch;

    const events = await collect({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ call: { name: "read_file", args: { path: "a.txt" } } });
  });
});
