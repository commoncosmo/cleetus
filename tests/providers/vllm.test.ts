import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildProvider } from "../../src/providers/factory";
import { ModelContextCache } from "../../src/providers/model-context-cache";
import { lowContextWarning } from "../../src/providers/native-context";
import { ProviderRegistry } from "../../src/providers/registry";
import { toolCallEnvelope } from "../../src/providers/structured-output";
import type { ChatOptions, StreamEvent } from "../../src/providers/types";
import { VLLMProvider } from "../../src/providers/vllm";

const originalFetch = globalThis.fetch;
let requests: { url: string; init?: RequestInit }[];
let respond: () => Response;
beforeEach(() => {
  requests = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return Promise.resolve(respond());
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const provider = () => buildProvider("vllm", "http://fixture:8000", "test-key");
async function collect(req: ChatOptions): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider().chat(req)) events.push(event);
  return events;
}

test("vLLM factory discovers aliased served context and primes runtime budgets", async () => {
  respond = () =>
    Response.json({
      data: [
        { id: "qwen2.5-7b-instruct", owned_by: "vllm", max_model_len: 32768 },
        ...[undefined, null, 0, -1, "32768"].map((limit, i) => ({
          id: `unknown-${i}`,
          max_model_len: limit,
        })),
      ],
    });
  const p = provider();
  expect(p).toBeInstanceOf(VLLMProvider);
  expect(await p.listModels()).toEqual([
    { id: "qwen2.5-7b-instruct", contextLength: 32768 },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `unknown-${i}` })),
  ]);
  const registry = new ProviderRegistry();
  registry.register("gpu", p);
  const cache = new ModelContextCache(registry);
  await cache.prime([{ provider: "gpu", model: "qwen2.5-7b-instruct" }]);
  expect(cache.getInfo("gpu", "qwen2.5-7b-instruct")).toEqual({ window: 32768, source: "loaded" });
  expect(requests.every((r) => r.url === "http://fixture:8000/v1/models")).toBe(true);
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");
  expect(lowContextWarning("coder", 8192, undefined, "vllm")).toContain("--max-model-len");
  expect(lowContextWarning("coder", 32768, undefined, "vllm")).toBeNull();
});

for (const reasoningField of ["reasoning", "reasoning_content"]) {
  test(`vLLM streams ${reasoningField}, usage and strict corrective tool envelopes`, async () => {
    const chunks = [
      { model: "coder", choices: [{ delta: { [reasoningField]: "Consider the file" } }] },
      { choices: [{ delta: { content: '{"name":"read_file",' } }] },
      {
        choices: [
          { delta: { content: '"arguments":{"path":"README.md"}}' }, finish_reason: "stop" },
        ],
      },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 9 } },
    ];
    respond = () =>
      new Response(
        `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`,
      );
    const responseFormat = toolCallEnvelope(["read_file"]);
    const signal = new AbortController().signal;
    const events = await collect({
      model: "coder",
      messages: [{ role: "user", content: "read it" }],
      responseFormat,
      reasoningEffort: "low",
      maxOutputTokens: 256,
      signal,
    });
    expect(events).toContainEqual({ type: "reasoning-delta", text: "Consider the file" });
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(0);
    expect(events).toContainEqual({
      type: "tool-call",
      call: { id: expect.any(String), name: "read_file", args: { path: "README.md" } },
      recovered: true,
    });
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "tool-calls",
      usage: { input: 12, output: 9 },
      model: "coder",
    });
    expect(requests[0]?.url).toBe("http://fixture:8000/v1/chat/completions");
    const request = JSON.parse(requests[0]?.init?.body as string);
    expect(request.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "tool_call", strict: true, schema: responseFormat?.schema },
    });
    expect(request.chat_template_kwargs).toBeUndefined();
    expect(request).toMatchObject({
      reasoning_effort: "low",
      max_tokens: 256,
      stream_options: { include_usage: true },
    });
    expect(requests[0]?.init?.signal).toBe(signal);
  });
}

test("vLLM embedding requests preserve model selection and Bearer auth", async () => {
  respond = () => Response.json({ data: [{ embedding: [0.1, 0.2] }] });
  expect(await provider().embed("hello", "embedding-model")).toEqual([0.1, 0.2]);
  expect(requests[0]?.url).toBe("http://fixture:8000/v1/embeddings");
  expect(JSON.parse(requests[0]?.init?.body as string)).toEqual({
    model: "embedding-model",
    input: "hello",
  });
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer test-key");
});

test("vLLM model authentication failures and parser setup errors stay actionable", async () => {
  respond = () => Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
  await expect(provider().listModels()).rejects.toThrow("Invalid API key");
  respond = () =>
    Response.json(
      {
        error: {
          message:
            '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
        },
      },
      { status: 400 },
    );
  await expect(
    collect({ model: "coder", messages: [{ role: "user", content: "read it" }] }),
  ).rejects.toThrow("--tool-call-parser");
});

test("vLLM forwards cancellation to an in-flight chat request", async () => {
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const abort = new AbortController();
  const pending = collect({
    model: "coder",
    messages: [{ role: "user", content: "hello" }],
    signal: abort.signal,
  });
  abort.abort();
  await expect(pending).rejects.toThrow("chat failed");
});
