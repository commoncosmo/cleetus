import { describe, expect, it } from "bun:test";
import { BraveProvider } from "../../../src/web/search/brave";

const JSON_FIXTURE = JSON.stringify({
  web: {
    results: [
      { title: "Bun", url: "https://bun.sh", description: "Fast toolkit" },
      { title: "Docs", url: "https://bun.sh/docs", description: "The docs" },
    ],
  },
});

describe("BraveProvider", () => {
  it("sends the subscription token and parses JSON results", async () => {
    let sentToken = "";
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sentToken = (init.headers as Record<string, string>)["X-Subscription-Token"]!;
      return new Response(JSON_FIXTURE, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const p = new BraveProvider("KEY123");
    const results = await p.search("bun", { limit: 5, fetchFn });
    expect(sentToken).toBe("KEY123");
    expect(results.length).toBe(2);
    expect(results[0]!).toEqual({ title: "Bun", url: "https://bun.sh", snippet: "Fast toolkit" });
  });

  it("respects the limit", async () => {
    const fetchFn = (async () =>
      new Response(JSON_FIXTURE, {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const results = await new BraveProvider("K").search("x", { limit: 1, fetchFn });
    expect(results.length).toBe(1);
  });

  it("throws a clear error on 401", async () => {
    const fetchFn = (async () =>
      new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(new BraveProvider("BAD").search("x", { limit: 5, fetchFn })).rejects.toThrow(
      "401",
    );
  });
});
