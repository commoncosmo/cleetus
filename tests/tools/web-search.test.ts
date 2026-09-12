import { describe, expect, it } from "bun:test";
import type { WebToolsConfig } from "../../src/config/types";
import { WebSearchTool } from "../../src/tools/web-search";

const cfg = (over: Partial<WebToolsConfig> = {}): WebToolsConfig => ({
  enabled: true,
  allowLocalhost: false,
  maxBytes: 1000,
  search: { provider: "duckduckgo" },
  ...over,
});
const ctx = () => ({ projectDir: "/tmp", abortSignal: new AbortController().signal });
const DDG = `
<a class="result__a" href="https://bun.sh/docs">Bun Docs</a>
<a class="result__snippet">Fast toolkit.</a>`;

describe("WebSearchTool", () => {
  it("renders results as numbered markdown", async () => {
    const fetchFn = (async () =>
      new Response(DDG, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const tool = new WebSearchTool(cfg(), { fetchFn, env: {} });
    const r = await tool.run({ query: "bun" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Bun Docs");
    expect(r.output).toContain("https://bun.sh/docs");
    expect(r.output).toContain("Fast toolkit.");
  });

  it("reports no results cleanly", async () => {
    const fetchFn = (async () =>
      new Response("<html></html>", {
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    const tool = new WebSearchTool(cfg(), { fetchFn, env: {} });
    const r = await tool.run({ query: "zzz" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("no results");
  });

  it("returns ok:false when disabled", async () => {
    const r = await new WebSearchTool(cfg({ enabled: false })).run({ query: "x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("disabled");
  });

  it("returns ok:false when brave is selected without a key", async () => {
    const tool = new WebSearchTool(cfg({ search: { provider: "brave" } }), { env: {} });
    const r = await tool.run({ query: "x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("returns ok:false with a timeout message when search exceeds timeoutMs", async () => {
    const fetchFn = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "TimeoutError")),
        );
      })) as unknown as typeof fetch;
    const tool = new WebSearchTool(cfg(), { fetchFn, env: {}, timeoutMs: 10 });
    const r = await tool.run({ query: "x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("timed out");
  });

  it("collapses newlines in rendered results", async () => {
    const braveJson = JSON.stringify({
      web: { results: [{ title: "Line1\nLine2", url: "https://x.io", description: "a\nb" }] },
    });
    const fetchFn = (async () =>
      new Response(braveJson, {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const tool = new WebSearchTool(cfg({ search: { provider: "brave", braveApiKey: "K" } }), {
      fetchFn,
      env: {},
    });
    const r = await tool.run({ query: "x" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Line1 Line2");
    expect(r.output).not.toContain("Line1\nLine2");
  });
});
