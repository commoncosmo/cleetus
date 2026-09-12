import { expect, test } from "bun:test";
import { WebFetchCache, normalizeCacheKey } from "../../src/web/fetch-cache";

test("normalizeCacheKey strips the #fragment, keeps query, trims", () => {
  expect(normalizeCacheKey("  https://x/doc?a=1#section-b  ")).toBe("https://x/doc?a=1");
  expect(normalizeCacheKey("https://x/doc")).toBe("https://x/doc");
});

test("miss → set → hit returns the stored value", () => {
  const c = new WebFetchCache();
  expect(c.get("https://x/doc")).toBeUndefined();
  c.set("https://x/doc", { body: "BODY", finalUrl: "https://x/doc" });
  expect(c.get("https://x/doc")).toEqual({ body: "BODY", finalUrl: "https://x/doc" });
});

test("fragment-only difference is the same cache entry", () => {
  const c = new WebFetchCache();
  c.set("https://x/doc#a", { body: "B", finalUrl: "https://x/doc" });
  expect(c.get("https://x/doc#b")?.body).toBe("B");
});

test("evicts the least-recently-used entry past the bound; get refreshes recency", () => {
  const c = new WebFetchCache(2);
  c.set("u1", { body: "1", finalUrl: "u1" });
  c.set("u2", { body: "2", finalUrl: "u2" });
  c.get("u1"); // u1 now most-recently-used → u2 is LRU
  c.set("u3", { body: "3", finalUrl: "u3" }); // evicts u2
  expect(c.get("u2")).toBeUndefined();
  expect(c.get("u1")?.body).toBe("1");
  expect(c.get("u3")?.body).toBe("3");
});
