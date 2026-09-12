import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OllamaProvider } from "../../src/providers/ollama";

const originalFetch = globalThis.fetch;
let routes: Record<string, () => Response>;

beforeEach(() => {
  routes = {
    "/v1/models": () =>
      new Response(JSON.stringify({ data: [{ id: "llama3:8b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };
  globalThis.fetch = ((url: string) => {
    for (const [frag, resp] of Object.entries(routes)) {
      if (url.includes(frag)) return Promise.resolve(resp());
    }
    return Promise.resolve(new Response("not mocked", { status: 404 }));
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OllamaProvider.listModels", () => {
  it("lists via /v1/models and merges /api/ps context lengths", async () => {
    routes["/api/ps"] = () =>
      new Response(JSON.stringify({ models: [{ name: "llama3:8b", context_length: 4096 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const p = new OllamaProvider({ baseUrl: "http://localhost:11434" });
    const m = await p.listModels();
    expect(m).toEqual([{ id: "llama3:8b", contextLength: 4096 }]);
  });

  it("returns the id-only list when /api/ps is unavailable", async () => {
    const p = new OllamaProvider({ baseUrl: "http://localhost:11434" });
    const m = await p.listModels();
    expect(m).toEqual([{ id: "llama3:8b" }]);
  });
});
