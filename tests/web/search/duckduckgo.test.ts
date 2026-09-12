import { describe, expect, it } from "bun:test";
import { DuckDuckGoProvider, parseDuckDuckGo } from "../../../src/web/search/duckduckgo";

const FIXTURE = `
<div class="result">
  <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs&rut=abc">Bun Docs</a>
  <a class="result__snippet">Bun is a fast all-in-one toolkit.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.com/direct">Direct Result</a>
  <a class="result__snippet">A directly-linked result.</a>
</div>`;

describe("parseDuckDuckGo", () => {
  it("extracts title, unwrapped url, and snippet", () => {
    const results = parseDuckDuckGo(FIXTURE, 10);
    expect(results.length).toBe(2);
    expect(results[0]!).toEqual({
      title: "Bun Docs",
      url: "https://bun.sh/docs",
      snippet: "Bun is a fast all-in-one toolkit.",
    });
    expect(results[1]!.url).toBe("https://example.com/direct");
  });
  it("respects the limit", () => {
    expect(parseDuckDuckGo(FIXTURE, 1).length).toBe(1);
  });
  it("does not mis-pair when an earlier result has no snippet", () => {
    const html = `
      <a class="result__a" href="https://a.com">A</a>
      <a class="result__a" href="https://b.com">B</a>
      <a class="result__snippet">snippet B</a>
      <a class="result__a" href="https://c.com">C</a>
      <a class="result__snippet">snippet C</a>`;
    const r = parseDuckDuckGo(html, 10);
    expect(r.length).toBe(3);
    expect(r[0]!).toEqual({ title: "A", url: "https://a.com", snippet: "" });
    expect(r[1]!).toEqual({ title: "B", url: "https://b.com", snippet: "snippet B" });
    expect(r[2]!).toEqual({ title: "C", url: "https://c.com", snippet: "snippet C" });
  });
});

describe("DuckDuckGoProvider", () => {
  it("gets the query and parses results", async () => {
    let requestedUrl = "";
    let requestedMethod = "";
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? "GET";
      return new Response(FIXTURE, {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const p = new DuckDuckGoProvider();
    const results = await p.search("bun", { limit: 5, fetchFn });
    expect(results[0]!.title).toBe("Bun Docs");
    expect(requestedMethod).toBe("GET");
    expect(new URL(requestedUrl).searchParams.get("q")).toBe("bun");
  });

  it("rejects DuckDuckGo's successful-status bot challenge instead of reporting no results", async () => {
    const fetchFn = (async () =>
      new Response('<div data-testid="anomaly-modal">Please complete the challenge</div>', {
        status: 202,
      })) as unknown as typeof fetch;
    const p = new DuckDuckGoProvider();
    expect(p.search("bun", { limit: 5, fetchFn })).rejects.toThrow(
      "DuckDuckGo search failed: HTTP 202",
    );
  });

  it("rejects a challenge page even if DuckDuckGo returns HTTP 200", async () => {
    const fetchFn = (async () =>
      new Response('<form id="challenge-form"></form>', {
        status: 200,
      })) as unknown as typeof fetch;
    const p = new DuckDuckGoProvider();
    expect(p.search("bun", { limit: 5, fetchFn })).rejects.toThrow(
      "DuckDuckGo search was temporarily challenged",
    );
  });
});
