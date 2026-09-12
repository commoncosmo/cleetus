import { afterEach, describe, expect, it } from "bun:test";
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

describe("chatOpenAI family stop sequences", () => {
  it("includes the GLM family stop sequences in the body", async () => {
    const cap = captureBody();
    await drain({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] });
    expect(cap.get().stop).toContain("<|observation|>");
  });

  it("omits stop for a family that defines none", async () => {
    const cap = captureBody();
    await drain({ model: "qwen2.5-coder", messages: [{ role: "user", content: "hi" }] });
    expect("stop" in cap.get()).toBe(false);
  });
});
