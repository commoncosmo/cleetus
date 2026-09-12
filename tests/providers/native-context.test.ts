import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  LOW_CONTEXT_THRESHOLD,
  fetchLMStudioModels,
  fetchLlamaCppProps,
  fetchOllamaContextLengths,
  fetchOllamaModelContext,
  llamaCppReadinessWarnings,
  lowContextWarning,
  parseLMStudioModels,
  parseLlamaCppContext,
  parseOllamaPs,
  parseOllamaShow,
} from "../../src/providers/native-context";
import { OllamaProvider } from "../../src/providers/ollama";

describe("parseLMStudioModels", () => {
  it("prefers loaded_context_length, falls back to max_context_length", () => {
    const out = parseLMStudioModels({
      data: [
        { id: "loaded", state: "loaded", loaded_context_length: 8192, max_context_length: 40960 },
        { id: "notloaded", state: "not-loaded", max_context_length: 32768 },
        { id: "bare" },
      ],
    });
    expect(out).toEqual([
      { id: "loaded", contextLength: 8192 },
      { id: "notloaded", contextLength: 32768 },
      { id: "bare" },
    ]);
  });

  it("returns [] for a missing/!array data field", () => {
    expect(parseLMStudioModels({})).toEqual([]);
    expect(parseLMStudioModels({ data: "nope" })).toEqual([]);
    expect(parseLMStudioModels(null)).toEqual([]);
  });
});

describe("parseOllamaPs", () => {
  it("maps loaded models' context_length keyed by name and model", () => {
    const m = parseOllamaPs({
      models: [
        { name: "qwen3:27b", model: "qwen3:27b-q4", context_length: 8192 },
        { name: "no-ctx" },
      ],
    });
    expect(m.get("qwen3:27b")).toBe(8192);
    expect(m.get("qwen3:27b-q4")).toBe(8192);
    expect(m.has("no-ctx")).toBe(false);
  });

  it("returns an empty map for missing/!array models", () => {
    expect(parseOllamaPs({}).size).toBe(0);
    expect(parseOllamaPs(null).size).toBe(0);
  });

  it("ignores zero, negative, and non-finite context sentinels", () => {
    const m = parseOllamaPs({
      models: [
        { name: "zero", context_length: 0 },
        { name: "negative", context_length: -1 },
        { name: "nan", context_length: Number.NaN },
      ],
    });
    expect(m.size).toBe(0);
  });
});

describe("lowContextWarning", () => {
  it("warns below the threshold with the model name and number", () => {
    const w = lowContextWarning("qwen3.6-27b", 8192);
    expect(w).toContain("qwen3.6-27b");
    expect(w).toContain("8192");
  });

  it("is null at/above the threshold and when unknown", () => {
    expect(lowContextWarning("m", LOW_CONTEXT_THRESHOLD)).toBeNull();
    expect(lowContextWarning("m", 32768)).toBeNull();
    expect(lowContextWarning("m", undefined)).toBeNull();
    expect(lowContextWarning("m", 0)).toBeNull();
  });

  it("respects a custom threshold", () => {
    expect(lowContextWarning("m", 8192, 4096)).toBeNull();
    expect(lowContextWarning("m", 2048, 4096)).not.toBeNull();
  });

  it("gives llama.cpp-specific context guidance", () => {
    const warning = lowContextWarning("m", 8192, LOW_CONTEXT_THRESHOLD, "llama.cpp");
    expect(warning).toContain("--ctx-size");
    expect(warning).toContain("LLAMA_ARG_CTX_SIZE");
    expect(warning).not.toContain("Ollama");
  });
});

describe("llama.cpp /props metadata", () => {
  it("parses the effective served context rather than the architectural model window", () => {
    expect(
      parseLlamaCppContext({
        default_generation_settings: { n_ctx: 32768 },
        model_meta: { n_ctx_train: 131072 },
      }),
    ).toBe(32768);
    expect(parseLlamaCppContext({ default_generation_settings: { n_ctx: 0 } })).toBeUndefined();
    expect(parseLlamaCppContext(null)).toBeUndefined();
  });

  it("warns only on explicit template capability failures", () => {
    expect(
      llamaCppReadinessWarnings({
        chat_template_caps: {
          supports_tools: false,
          supports_tool_calls: false,
          supports_system_role: false,
        },
      }),
    ).toEqual([expect.stringContaining("--jinja"), expect.stringContaining("system messages")]);
    expect(llamaCppReadinessWarnings({ chat_template_caps: {} })).toEqual([]);
    expect(llamaCppReadinessWarnings({})).toEqual([]);
  });

  it("fetches /props with a URL-encoded router model and API key", async () => {
    const realFetch = globalThis.fetch;
    let requestedUrl = "";
    let authorization = "";
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      requestedUrl = url;
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(
        new Response(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }), {
          status: 200,
        }),
      );
    }) as typeof fetch;
    try {
      expect(
        parseLlamaCppContext(
          await fetchLlamaCppProps(
            { baseUrl: "http://host:8080", apiKey: "secret" },
            "org/model:Q4_K_M",
          ),
        ),
      ).toBe(16384);
      expect(requestedUrl).toBe("http://host:8080/props?model=org%2Fmodel%3AQ4_K_M");
      expect(authorization).toBe("Bearer secret");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("fetchLMStudioModels / fetchOllamaContextLengths", () => {
  const realFetch = globalThis.fetch;
  let routes: Record<string, () => Response>;
  beforeEach(() => {
    routes = {};
    globalThis.fetch = ((url: string) => {
      for (const [frag, resp] of Object.entries(routes)) {
        if (url.includes(frag)) return Promise.resolve(resp());
      }
      return Promise.resolve(new Response("not mocked", { status: 404 }));
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fetchLMStudioModels hits /api/v0/models and parses context", async () => {
    routes["/api/v0/models"] = () =>
      new Response(JSON.stringify({ data: [{ id: "m", loaded_context_length: 8192 }] }), {
        status: 200,
      });
    const out = await fetchLMStudioModels({ baseUrl: "http://h:1234" });
    expect(out).toEqual([{ id: "m", contextLength: 8192 }]);
  });

  it("fetchLMStudioModels throws on a non-OK native response", async () => {
    routes["/api/v0/models"] = () => new Response("nope", { status: 404 });
    await expect(fetchLMStudioModels({ baseUrl: "http://h:1234" })).rejects.toThrow();
  });

  it("fetchOllamaContextLengths reads /api/ps, empty map on failure", async () => {
    routes["/api/ps"] = () =>
      new Response(JSON.stringify({ models: [{ name: "x", context_length: 4096 }] }), {
        status: 200,
      });
    expect((await fetchOllamaContextLengths({ baseUrl: "http://h:11434" })).get("x")).toBe(4096);
    routes = {}; // now /api/ps 404s
    expect((await fetchOllamaContextLengths({ baseUrl: "http://h:11434" })).size).toBe(0);
  });

  it("fetchOllamaContextLengths returns an empty map when fetch throws", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    expect((await fetchOllamaContextLengths({ baseUrl: "http://h:11434" })).size).toBe(0);
  });
});

describe("parseOllamaShow", () => {
  it("reads the single model_info key ending in .context_length", () => {
    expect(
      parseOllamaShow({
        model_info: { "glm5.2.context_length": 1000000, "glm5.2.block_count": 92 },
      }),
    ).toBe(1000000);
    expect(parseOllamaShow({ model_info: { "llama.context_length": 131072 } })).toBe(131072);
  });
  it("returns undefined when absent, non-numeric, or malformed", () => {
    expect(parseOllamaShow({ model_info: { "glm5.2.block_count": 92 } })).toBeUndefined();
    expect(parseOllamaShow({ model_info: { "llama.context_length": "nope" } })).toBeUndefined();
    expect(parseOllamaShow({})).toBeUndefined();
    expect(parseOllamaShow(null)).toBeUndefined();
    expect(parseOllamaShow({ model_info: "x" })).toBeUndefined();
    expect(parseOllamaShow({ model_info: { "llama.context_length": 0 } })).toBeUndefined();
  });

  it("continues past an invalid context key when another architecture reports a usable window", () => {
    expect(
      parseOllamaShow({
        model_info: {
          "broken.context_length": 0,
          "qwen3.context_length": 262_144,
        },
      }),
    ).toBe(262_144);
  });
});

describe("fetchOllamaModelContext / OllamaProvider.probeModelContext", () => {
  const realFetch = globalThis.fetch;
  let lastBody: string | undefined;
  afterEach(() => {
    globalThis.fetch = realFetch;
    lastBody = undefined;
  });
  function mock(status: number, json: unknown) {
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      lastBody = init?.body as string | undefined;
      return Promise.resolve(new Response(JSON.stringify(json), { status }));
    }) as typeof fetch;
  }

  it("POSTs /api/show with the requested name (incl. :cloud) and returns the window", async () => {
    mock(200, { model_info: { "glm5.2.context_length": 1000000 } });
    const w = await fetchOllamaModelContext({ baseUrl: "http://x" }, "glm-5.2:cloud");
    expect(w).toBe(1000000);
    expect(JSON.parse(lastBody as string)).toEqual({ name: "glm-5.2:cloud" });
  });

  it("returns undefined on a non-OK response", async () => {
    mock(404, { error: "not found" });
    expect(await fetchOllamaModelContext({ baseUrl: "http://x" }, "missing")).toBeUndefined();
  });

  it("OllamaProvider.probeModelContext delegates to /api/show", async () => {
    mock(200, { model_info: { "llama.context_length": 131072 } });
    const p = new OllamaProvider({ baseUrl: "http://x" });
    expect(await p.probeModelContext("llama3")).toBe(131072);
  });
});
