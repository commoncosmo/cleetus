import { afterEach, beforeEach, expect, test } from "bun:test";
import { ProviderConfigSchema } from "../../src/config/schema";
import { buildProvider } from "../../src/providers/factory";
import { ModelContextCache } from "../../src/providers/model-context-cache";
import { ProviderRegistry } from "../../src/providers/registry";
import { StrataProvider } from "../../src/providers/strata";
import { toolCallEnvelope } from "../../src/providers/structured-output";
import type { ChatOptions, StreamEvent } from "../../src/providers/types";
import { providerEnvironmentChecks } from "../../src/setup/provider-environment";

const originalFetch = globalThis.fetch;
let requests: { url: string; init?: RequestInit }[];
let serve: (url: string, init?: RequestInit) => Response;
const models = () =>
  Response.json({
    data: [{ id: "iq3_s", owned_by: "strata", meta: { label: "Qwen3.8-Flash-Next IQ3_S" } }],
  });
function sse(content: string) {
  return new Response(
    `data: ${JSON.stringify({ model: "iq3_s", choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
  );
}
beforeEach(() => {
  requests = [];
  serve = (url) =>
    url.endsWith("/models") ? models() : new Response("not found", { status: 404 });
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Promise.resolve(serve(String(url), init));
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
async function collect(provider: StrataProvider, overrides: Partial<ChatOptions> = {}) {
  const events: StreamEvent[] = [];
  for await (const event of provider.chat({
    model: "iq3_s",
    messages: [{ role: "user", content: "test" }],
    ...overrides,
  }))
    events.push(event);
  return events;
}
const tool = {
  name: "echo_probe",
  description: "Echo a value",
  parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
};

test("Strata config, factory and alias metadata select Qwen without renaming the wire model", async () => {
  expect(
    ProviderConfigSchema.parse({
      type: "strata",
      base_url: "http://fixture",
      context_length: 32768,
    }).context_length,
  ).toBe(32768);
  expect(
    ProviderConfigSchema.safeParse({
      type: "strata",
      base_url: "http://fixture",
      context_length: 0,
    }).success,
  ).toBe(false);
  const provider = buildProvider("strata", "http://fixture", "key");
  expect(provider).toBeInstanceOf(StrataProvider);
  serve = (url) => (url.endsWith("/models") ? models() : sse("OK"));
  await collect(provider as StrataProvider);
  const body = JSON.parse(requests.at(-1)?.init?.body as string);
  expect(body).toMatchObject({ model: "iq3_s", temperature: 0.7, top_p: 0.8, top_k: 20 });
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer key");
});

test("family disable and explicit overrides win over Strata labels", async () => {
  serve = (url) => (url.endsWith("/models") ? models() : sse("OK"));
  const provider = new StrataProvider({ baseUrl: "http://fixture" });
  await provider.listModels();
  await collect(provider, { modelFamily: { enabled: false } });
  expect(JSON.parse(requests.at(-1)?.init?.body as string).temperature).toBeUndefined();
  await collect(provider, { modelFamily: { override: "granite" } });
  expect(JSON.parse(requests.at(-1)?.init?.body as string).temperature).toBe(0);
});

test("Strata corrective envelopes omit native tools, preserve definitions and synthesize a recovered call", async () => {
  serve = (url) =>
    url.endsWith("/models")
      ? models()
      : sse('{"name":"echo_probe","arguments":{"value":"strata-ok"}}');
  const events = await collect(new StrataProvider({ baseUrl: "http://fixture" }), {
    tools: [tool],
    responseFormat: toolCallEnvelope([tool.name]),
    reasoningEffort: "low",
  });
  const body = JSON.parse(requests.at(-1)?.init?.body as string);
  expect(body.tools).toBeUndefined();
  expect(body.response_format.type).toBe("json_schema");
  expect(body.messages.at(-1).content).toContain(JSON.stringify([tool]));
  expect(events.filter((e) => e.type === "text-delta")).toHaveLength(0);
  expect(events).toContainEqual({
    type: "tool-call",
    call: { id: expect.any(String), name: "echo_probe", args: { value: "strata-ok" } },
    recovered: true,
  });
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    reason: "tool-calls",
    usage: { input: 12, output: 8 },
  });
});

test("ordinary tools stay native; plain JSON requests omit native tools without injecting a tool envelope", async () => {
  serve = (url) => (url.endsWith("/models") ? models() : sse("{}"));
  const provider = new StrataProvider({ baseUrl: "http://fixture" });
  await collect(provider, { tools: [tool] });
  expect(JSON.parse(requests.at(-1)?.init?.body as string).tools[0].function.name).toBe(tool.name);
  await collect(provider, {
    tools: [tool],
    responseFormat: { kind: "json", name: "probe", schema: { type: "object" } },
  });
  const body = JSON.parse(requests.at(-1)?.init?.body as string);
  expect(body.tools).toBeUndefined();
  expect(body.messages).toHaveLength(1);
});

test("native served context overrides configured fallback and primes runtime budgets", async () => {
  serve = (url) =>
    url.endsWith("/models")
      ? models()
      : Response.json({
          default_generation_settings: { n_ctx: 16384 },
          chat_template_caps: { supports_tools: false },
        });
  const provider = new StrataProvider({ baseUrl: "http://fixture", contextLength: 131072 });
  const registry = new ProviderRegistry();
  registry.register("strata", provider);
  const cache = new ModelContextCache(registry);
  await cache.prime([{ provider: "strata", model: "iq3_s" }]);
  expect(cache.getInfo("strata", "iq3_s")).toEqual({ window: 16384, source: "loaded" });
  expect((await provider.readinessWarnings("iq3_s")).join(" ")).toContain(
    "does not support tool calls",
  );
  expect(requests.find((r) => r.url.includes("/props"))?.url).toContain("model=iq3_s");
});

test("hidden /props uses the configured context without inventing a model window", async () => {
  const provider = buildProvider("strata", "http://fixture", undefined, {
    contextLength: 32768,
  }) as StrataProvider;
  const registry = new ProviderRegistry();
  registry.register("strata", provider);
  const cache = new ModelContextCache(registry);
  await cache.prime([{ provider: "strata", model: "iq3_s" }]);
  expect(cache.getInfo("strata", "iq3_s")).toEqual({ window: 32768, source: "configured" });
  expect((await provider.readinessWarnings("iq3_s")).join(" ")).toContain(
    "configured context_length: 32768",
  );
  const unknown = new StrataProvider({ baseUrl: "http://fixture" });
  expect(await unknown.probeModelContextInfo("iq3_s")).toBeUndefined();
  expect((await unknown.readinessWarnings("iq3_s")).join(" ")).toContain("context window unknown");
});

test("invalid native windows fall back; failed metadata does not prevent chat", async () => {
  serve = (url) =>
    url.endsWith("/chat/completions") ? sse("OK") : new Response("offline", { status: 503 });
  const provider = new StrataProvider({ baseUrl: "http://fixture", contextLength: 8192 });
  expect(await provider.probeModelContextInfo("alias")).toEqual({
    window: 8192,
    source: "configured",
  });
  expect(await collect(provider)).toContainEqual({ type: "text-delta", text: "OK" });
});

test("context cache replaces configured evidence with loaded evidence, never the reverse", async () => {
  let now = 0;
  const provider = new StrataProvider({ baseUrl: "http://fixture", contextLength: 65536 });
  const registry = new ProviderRegistry();
  registry.register("strata", provider);
  const cache = new ModelContextCache(registry, { now: () => now, refreshIntervalMs: 5000 });
  await cache.prime([{ provider: "strata", model: "iq3_s" }]);
  expect(cache.getInfo("strata", "iq3_s")?.source).toBe("configured");
  // A fresh provider represents a native route becoming available after reconnect.
  serve = (url) =>
    url.endsWith("/models")
      ? models()
      : Response.json({ default_generation_settings: { n_ctx: 8192 } });
  registry.register(
    "strata",
    new StrataProvider({ baseUrl: "http://fixture", contextLength: 65536 }),
  );
  now = 10000;
  await cache.probe("strata", "iq3_s");
  expect(cache.getInfo("strata", "iq3_s")).toEqual({ window: 8192, source: "loaded" });
});

test("already-cancelled Strata requests do not perform discovery or inference", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    collect(new StrataProvider({ baseUrl: "http://fixture" }), { signal: controller.signal }),
  ).rejects.toBe(controller.signal.reason);
  expect(requests).toHaveLength(0);
});

test("cancellation interrupts alias discovery without waiting for the metadata deadline", async () => {
  globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const controller = new AbortController();
  const pending = collect(new StrataProvider({ baseUrl: "http://fixture" }), {
    signal: controller.signal,
  });
  controller.abort(new Error("cancel discovery"));
  await expect(pending).rejects.toBe(controller.signal.reason);
});

test("Strata never borrows another model's loaded context and rejects invalid configured windows", async () => {
  serve = (url) =>
    url.endsWith("/models")
      ? models()
      : Response.json({
          model_alias: "another-model",
          default_generation_settings: { n_ctx: 262144 },
        });
  const provider = new StrataProvider({ baseUrl: "http://fixture", contextLength: 8192 });
  expect(await provider.probeModelContextInfo("iq3_s")).toEqual({
    window: 8192,
    source: "configured",
  });
  for (const context_length of [-1, 0, 1.5, "32768"])
    expect(
      ProviderConfigSchema.safeParse({ type: "strata", base_url: "http://fixture", context_length })
        .success,
    ).toBe(false);
  expect(
    ProviderConfigSchema.safeParse({
      type: "vllm",
      base_url: "http://fixture",
      context_length: 32768,
    }).success,
  ).toBe(false);
});

test("doctor surfaces missing Strata context metadata with configuration guidance", async () => {
  const checks = await providerEnvironmentChecks([
    ["lab", { type: "strata", baseUrl: "http://fixture" }],
  ]);
  expect(checks[0]?.status).toBe("warn");
  expect(checks[0]?.detail).toContain("context_length");
});
