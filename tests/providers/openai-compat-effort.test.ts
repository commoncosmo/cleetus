import { afterEach, describe, expect, it } from "bun:test";
import { chatOpenAI } from "../../src/providers/openai-compat";
import type { ChatOptions } from "../../src/providers/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Capture the JSON body sent to /chat/completions; return a minimal valid SSE stream.
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

describe("chatOpenAI reasoning_effort", () => {
  it("includes reasoning_effort in the body when reasoningEffort is set", async () => {
    const cap = captureBody();
    await drain({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      reasoningEffort: "high",
    });
    expect(cap.get().reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort from the body when reasoningEffort is undefined", async () => {
    const cap = captureBody();
    await drain({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect("reasoning_effort" in cap.get()).toBe(false);
  });

  it("forwards an explicit output-token ceiling and otherwise omits it", async () => {
    const capped = captureBody();
    await drain({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 1024,
    });
    expect(capped.get().max_tokens).toBe(1024);

    const uncapped = captureBody();
    await drain({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect("max_tokens" in uncapped.get()).toBe(false);
  });
});
