import { afterEach, describe, expect, it, test } from "bun:test";
import { chatOpenAI } from "../../src/providers/openai-compat";
import { toolCallEnvelope } from "../../src/providers/structured-output";
import type { ChatOptions, StreamEvent } from "../../src/providers/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureBody(): { get: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    return Promise.resolve(
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
  }) as unknown as typeof fetch;
  return { get: () => captured };
}

async function drain(req: ChatOptions): Promise<void> {
  for await (const _ of chatOpenAI({ baseUrl: "http://x" }, req)) {
    // consume
  }
}

/** Scripts a fetch stub that streams each entry of `contentPieces` as a separate
 *  `delta.content` SSE frame, then a `finish_reason` frame (default "stop") + `[DONE]`. Mirrors
 *  `captureBody` above but returns caller-controlled content instead of an empty stream. */
function stubSse(contentPieces: string[], finishReason = "stop"): void {
  globalThis.fetch = ((_url: string, _init: RequestInit) => {
    const frames = contentPieces.map(
      (piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
    );
    frames.push(`data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}\n\n`);
    frames.push("data: [DONE]\n\n");
    return Promise.resolve(
      new Response(frames.join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  }) as unknown as typeof fetch;
}

async function collect(req: ChatOptions): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of chatOpenAI({ baseUrl: "http://x" }, req)) {
    events.push(ev);
  }
  return events;
}

describe("chatOpenAI response_format", () => {
  it("maps responseFormat to a strict json_schema block", async () => {
    const cap = captureBody();
    await drain({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      responseFormat: {
        name: "tool_call",
        kind: "tool-call",
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
    });
    expect(cap.get().response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "tool_call",
        strict: true,
        schema: { type: "object", properties: {}, additionalProperties: false },
      },
    });
  });

  it("uses llama.cpp's direct schema dialect when requested", async () => {
    const cap = captureBody();
    for await (const _ of chatOpenAI(
      { baseUrl: "http://x", responseFormatStyle: "llama.cpp" },
      {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        responseFormat: {
          name: "tool_call",
          kind: "tool-call",
          schema: { type: "object", properties: {} },
        },
      },
    )) {
      // consume
    }
    expect(cap.get().response_format).toEqual({
      type: "json_object",
      schema: { type: "object", properties: {} },
    });
    expect(cap.get().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("omits response_format when absent", async () => {
    const cap = captureBody();
    await drain({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect("response_format" in cap.get()).toBe(false);
    expect("chat_template_kwargs" in cap.get()).toBe(false);
  });
});

describe("chatOpenAI tool-call envelope synthesis", () => {
  it("suppresses live deltas and synthesizes a tool call from envelope content", async () => {
    stubSse(['{"name":"bash","arguments":{"command":"ls"}}']); // content frames
    const events = await collect({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "bash", description: "", parameters: { type: "object" } }],
      responseFormat: toolCallEnvelope(["bash"]),
    });
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(0);
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      recovered: true,
      call: { name: "bash", args: { command: "ls" } },
    });
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ reason: "tool-calls" });
  });

  it("flushes buffered content as one text-delta when envelope parsing fails", async () => {
    stubSse(["sorry, here is prose instead"]);
    const events = await collect({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      responseFormat: toolCallEnvelope(["bash"]),
    });
    const deltas = events.filter((e) => e.type === "text-delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { text: string }).text).toBe("sorry, here is prose instead");
  });

  it('kind "json" streams deltas normally', async () => {
    stubSse(["{", '"brief":"x"}']);
    const events = await collect({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      responseFormat: { name: "plan", kind: "json", schema: { type: "object" } },
    });
    expect(events.filter((e) => e.type === "text-delta").length).toBeGreaterThan(1);
  });
});

test("truncated envelope JSON is NOT flushed as prose", async () => {
  stubSse(['{"name":"edit_fi'], "length");
  const events = await collect({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    responseFormat: toolCallEnvelope(["edit_file"]),
  });
  expect(events.filter((e) => e.type === "text-delta")).toHaveLength(0);
  expect(events.filter((e) => e.type === "tool-call")).toHaveLength(0);
});

test("valid non-envelope JSON still flushes", async () => {
  stubSse(['{"foo": 1}'], "stop");
  const events = await collect({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    responseFormat: toolCallEnvelope(["bash"]),
  });
  const deltas = events.filter((e) => e.type === "text-delta");
  expect(deltas).toHaveLength(1);
  expect((deltas[0] as { text: string }).text).toBe('{"foo": 1}');
});
