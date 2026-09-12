import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildProvider } from "../../src/providers/factory";
import { LlamaCppProvider } from "../../src/providers/llama-cpp";

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(props: unknown): void {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/v1/models")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "coder" }] }), { status: 200 }),
      );
    }
    if (url.includes("/props")) {
      return Promise.resolve(new Response(JSON.stringify(props), { status: 200 }));
    }
    if (url.includes("/v1/chat/completions")) {
      const sse = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return Promise.resolve(
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

describe("LlamaCppProvider", () => {
  it("is constructed for the llama.cpp configuration type", () => {
    expect(buildProvider("llama.cpp", "http://host:8080")).toBeInstanceOf(LlamaCppProvider);
  });

  it("lists the model through the OpenAI-compatible endpoint", async () => {
    installFetch({});
    const provider = new LlamaCppProvider({ baseUrl: "http://host:8080" });
    expect(await provider.listModels()).toEqual([{ id: "coder" }]);
    expect(calls[0]?.url).toBe("http://host:8080/v1/models");
  });

  it("uses /props for effective context and readiness, caching one request per model", async () => {
    installFetch({
      default_generation_settings: { n_ctx: 32768 },
      chat_template_caps: { supports_tools: false, supports_tool_calls: false },
    });
    const provider = new LlamaCppProvider({ baseUrl: "http://host:8080" });
    expect(await provider.probeModelContextInfo("coder")).toEqual({
      window: 32768,
      source: "loaded",
    });
    expect(await provider.readinessWarnings("coder")).toEqual([expect.stringContaining("--jinja")]);
    expect(calls.filter((call) => call.url.includes("/props"))).toHaveLength(1);
  });

  it("uses llama.cpp's direct response-format schema", async () => {
    installFetch({});
    const provider = new LlamaCppProvider({ baseUrl: "http://host:8080" });
    for await (const _ of provider.chat({
      model: "coder",
      messages: [{ role: "user", content: "hi" }],
      responseFormat: { name: "answer", kind: "json", schema: { type: "object" } },
    })) {
      // consume
    }
    const chat = calls.find((call) => call.url.includes("/v1/chat/completions"));
    const body = JSON.parse(chat?.init?.body as string);
    expect(body.response_format).toEqual({ type: "json_object", schema: { type: "object" } });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("treats an unavailable /props endpoint as advisory-only", async () => {
    globalThis.fetch = ((url: string) => {
      calls.push({ url });
      return Promise.resolve(new Response("missing", { status: 404 }));
    }) as typeof fetch;
    const provider = new LlamaCppProvider({ baseUrl: "http://host:8080" });
    expect(await provider.probeModelContextInfo("coder")).toBeUndefined();
    expect(await provider.readinessWarnings("coder")).toEqual([]);
  });
});
