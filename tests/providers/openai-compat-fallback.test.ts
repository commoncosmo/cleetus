import { afterEach, describe, expect, it } from "bun:test";
import { fallbackStopSequences } from "../../src/providers/families/registry";
import { chatOpenAI } from "../../src/providers/openai-compat";
import type { ChatOptions } from "../../src/providers/types";

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

describe("chatOpenAI unknown-family fallback profile", () => {
  it("unknown model id gets the conservative fallback sampling", async () => {
    const cap = captureBody();
    await drain({ model: "totally-unknown-model", messages: [{ role: "user", content: "hi" }] });
    expect(cap.get().temperature).toBe(0.6);
    expect(cap.get().top_p).toBe(0.95);
    expect(cap.get().presence_penalty).toBe(0.5);
  });

  it("unknown model id gets the union of known stop sequences", async () => {
    const cap = captureBody();
    await drain({ model: "totally-unknown-model", messages: [{ role: "user", content: "hi" }] });
    expect(cap.get().stop).toContain("<|observation|>");
  });

  it("caller-supplied sampling wins over the fallback", async () => {
    const cap = captureBody();
    await drain({
      model: "totally-unknown-model",
      temperature: 0.1,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(cap.get().temperature).toBe(0.1);
  });

  it("model_family disabled sends neither fallback sampling nor stops", async () => {
    const cap = captureBody();
    await drain({
      model: "totally-unknown-model",
      modelFamily: { enabled: false },
      messages: [{ role: "user", content: "hi" }],
    });
    expect("temperature" in cap.get()).toBe(false);
    expect("stop" in cap.get()).toBe(false);
  });

  it("known families are unaffected (qwen keeps its own sampling, no stop)", async () => {
    const cap = captureBody();
    await drain({ model: "qwen2.5-coder", messages: [{ role: "user", content: "hi" }] });
    expect(cap.get().temperature).toBe(0.7);
    expect("stop" in cap.get()).toBe(false);
  });
});

describe("fallbackStopSequences", () => {
  it("unions every family's stop sequences without duplicates", () => {
    const stops = fallbackStopSequences();
    expect(stops).toContain("<|observation|>");
    expect(stops).toContain("<|endoftext|>");
    expect(new Set(stops).size).toBe(stops.length);
  });
});
