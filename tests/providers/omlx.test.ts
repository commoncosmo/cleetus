import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildProvider } from "../../src/providers/factory";
import { ModelContextCache } from "../../src/providers/model-context-cache";
import { OMLXProvider } from "../../src/providers/omlx";
import { listModelsOpenAI } from "../../src/providers/openai-compat";
import { ProviderRegistry } from "../../src/providers/registry";

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; init?: RequestInit }> = [];
let respond: () => Response;

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function models(data: unknown[]): void {
  respond = () => Response.json({ object: "list", data });
}

function stream(chunks: unknown[]): void {
  respond = () =>
    new Response(
      `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
      {
        headers: { "content-type": "text/event-stream" },
      },
    );
}

describe("OMLXProvider", () => {
  it("lists aliased models and their effective context through the configured factory", async () => {
    models([{ id: "coding-alias", owned_by: "omlx", max_model_len: 65536 }]);
    const provider = buildProvider("omlx", "http://host:8000", "test-key");
    expect(provider).toBeInstanceOf(OMLXProvider);
    expect(await provider.listModels()).toEqual([{ id: "coding-alias", contextLength: 65536 }]);
    expect(calls[0]?.url).toBe("http://host:8000/v1/models");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");
  });

  it("ignores missing, null, and invalid context metadata from older or incomplete servers", async () => {
    models([
      { id: "old" },
      { id: "null", max_model_len: null },
      { id: "zero", max_model_len: 0 },
      { id: "negative", max_model_len: -1 },
      { id: "string", max_model_len: "32768" },
    ]);
    expect(await buildProvider("omlx", "http://host:8000").listModels()).toEqual([
      { id: "old" },
      { id: "null" },
      { id: "zero" },
      { id: "negative" },
      { id: "string" },
    ]);
    expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(false);
  });

  it("does not change other providers' model-list context behavior", async () => {
    models([{ id: "coder", max_model_len: 65536 }]);
    expect(await listModelsOpenAI({ baseUrl: "http://host:8080" })).toEqual([{ id: "coder" }]);
  });

  it("primes the runtime context budget from the served model window", async () => {
    models([{ id: "coder", max_model_len: 32768 }]);
    const registry = new ProviderRegistry();
    registry.register("mac", buildProvider("omlx", "http://host:8000"));
    const cache = new ModelContextCache(registry);
    await cache.prime([{ provider: "mac", model: "coder" }]);
    expect(cache.getInfo("mac", "coder")).toEqual({ window: 32768, source: "loaded" });
    expect(calls).toHaveLength(1);
  });

  it("streams reasoning, text, fragmented tool calls, and usage with OpenAI request options", async () => {
    stream([
      { model: "coding-alias", choices: [{ delta: { reasoning_content: "Thinking" } }] },
      { choices: [{ delta: { content: "Reading" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ]);
    const provider = buildProvider("omlx", "http://host:8000", "test-key");
    const signal = new AbortController().signal;
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const events = [];
    for await (const event of provider.chat({
      model: "coding-alias",
      modelFamily: { enabled: false },
      messages: [{ role: "user", content: "read a.ts" }],
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      maxOutputTokens: 512,
      reasoningEffort: "low",
      responseFormat: { name: "result", schema, kind: "json" },
      signal,
    }))
      events.push(event);
    expect(events).toContainEqual({ type: "reasoning-delta", text: "Thinking" });
    expect(events).toContainEqual({ type: "text-delta", text: "Reading" });
    expect(events).toContainEqual({
      type: "tool-call",
      call: { id: "call-1", name: "read_file", args: { path: "a.ts" } },
    });
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "tool-calls",
      usage: { input: 12, output: 7 },
      model: "coding-alias",
    });
    const call = calls[0]!;
    expect(call.url).toBe("http://host:8000/v1/chat/completions");
    expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(call.init?.signal).toBe(signal);
    const body = JSON.parse(call.init?.body as string);
    expect(body).toMatchObject({
      model: "coding-alias",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 512,
      reasoning_effort: "low",
      tools: [{ type: "function", function: { name: "read_file" } }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema },
      },
    });
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it("embeds with an explicitly selected embedding model and API key", async () => {
    respond = () => Response.json({ data: [{ embedding: [0.1, 0.2] }] });
    const provider = buildProvider("omlx", "http://host:8000", "test-key");
    expect(await provider.embed("hello", "embedding-model")).toEqual([0.1, 0.2]);
    expect(calls[0]?.url).toBe("http://host:8000/v1/embeddings");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({
      input: "hello",
      model: "embedding-model",
    });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");
  });

  it("surfaces model-list authentication errors", async () => {
    respond = () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
    await expect(buildProvider("omlx", "http://host:8000").listModels()).rejects.toThrow(
      "Invalid API key",
    );
  });
});
