import { describe, expect, it } from "bun:test";
import type { WebToolsConfig } from "../../src/config/types";
import { WebFetchTool } from "../../src/tools/web-fetch";
import type { TransportFn, TransportResponse } from "../../src/web/fetch";
import { WebFetchCache } from "../../src/web/fetch-cache";

const cfg = (over: Partial<WebToolsConfig> = {}): WebToolsConfig => ({
  enabled: true,
  allowLocalhost: false,
  maxBytes: 1000,
  search: { provider: "duckduckgo" },
  ...over,
});
const ctx = () => ({ projectDir: "/tmp", abortSignal: new AbortController().signal });

function res(body: string, headers: Record<string, string>, status = 200): TransportResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => body,
    dispose: () => {},
  };
}

describe("WebFetchTool", () => {
  it("fetches, converts, and wraps in a provenance envelope", async () => {
    const transport: TransportFn = async () => res("<h1>Hi</h1>", { "content-type": "text/html" });
    const tool = new WebFetchTool(cfg(), { transport });
    const r = await tool.run({ url: "https://example.com/" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("<untrusted-web-content");
    expect(r.output).toContain("# Hi");
  });

  it("returns ok:false when disabled", async () => {
    const tool = new WebFetchTool(cfg({ enabled: false }));
    const r = await tool.run({ url: "https://example.com/" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("disabled");
  });

  it("returns ok:false (not throw) on an SSRF refusal", async () => {
    // No injected transport: the real IP-pinning transport validates and refuses
    // a loopback literal before any connection.
    const tool = new WebFetchTool(cfg());
    const r = await tool.run({ url: "http://127.0.0.1/" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("refused");
  });

  it("returns ok:false with a timeout message when the fetch exceeds timeoutMs", async () => {
    // Transport that never resolves until its signal aborts.
    const transport: TransportFn = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "TimeoutError")),
        );
      });
    const tool = new WebFetchTool(cfg(), { transport, timeoutMs: 10 });
    const r = await tool.run({ url: "https://example.com/" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("timed out");
  });

  it("serializes for the permission prompt", () => {
    expect(new WebFetchTool(cfg()).serialize({ url: "https://x.com" })).toBe(
      "web_fetch https://x.com",
    );
  });

  it("serves a repeat fetch from the session cache without re-calling the transport", async () => {
    let calls = 0;
    const transport: TransportFn = async () => {
      calls += 1;
      return res("<h1>Hi</h1>", { "content-type": "text/html" });
    };
    const cache = new WebFetchCache();
    const tool = new WebFetchTool(cfg(), { transport, cache });
    const a = await tool.run({ url: "https://example.com/doc" }, ctx());
    const b = await tool.run({ url: "https://example.com/doc" }, ctx());
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls).toBe(1); // second call served from cache
    expect(b.output).toContain("cache");
    expect(b.output).toContain("# Hi");
  });

  it("does not cache a failed fetch", async () => {
    let calls = 0;
    const transport: TransportFn = async () => {
      calls += 1;
      throw new Error("network down");
    };
    const cache = new WebFetchCache();
    const tool = new WebFetchTool(cfg(), { transport, cache });
    await tool.run({ url: "https://example.com/err" }, ctx());
    await tool.run({ url: "https://example.com/err" }, ctx());
    expect(calls).toBe(2); // error never cached → re-fetched
  });
});
