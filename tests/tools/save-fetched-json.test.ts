import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SaveFetchedJsonTool } from "../../src/tools/save-fetched-json";
import { WebFetchCache } from "../../src/web/fetch-cache";

let dir: string;
const signal = new AbortController().signal;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-save-fetch-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SaveFetchedJsonTool", () => {
  it("writes the exact cached JSON without model reconstruction", async () => {
    const cache = new WebFetchCache();
    const body = '{"periods":[{"number":1},{"number":2}]}';
    cache.set("https://example.test/forecast", {
      body,
      finalUrl: "https://example.test/forecast",
      complete: true,
    });
    const result = await new SaveFetchedJsonTool(cache).run(
      { url: "https://example.test/forecast", path: "forecast.json" },
      { projectDir: dir, abortSignal: signal },
    );

    expect(result.ok).toBe(true);
    expect(result.diff?.after).toBe(body);
    expect(await readFile(join(dir, "forecast.json"), "utf8")).toBe(body);
    expect(result.output).toContain("saved exact cached JSON");
  });

  it("refuses missing, truncated, and non-JSON cache entries", async () => {
    const cache = new WebFetchCache();
    const tool = new SaveFetchedJsonTool(cache);
    expect(
      (
        await tool.run(
          { url: "https://example.test/missing", path: "x.json" },
          { projectDir: dir, abortSignal: signal },
        )
      ).errorMessage,
    ).toContain("not in");

    cache.set("https://example.test/capped", {
      body: '{"x":1}\n[truncated]',
      finalUrl: "https://example.test/capped",
      complete: false,
    });
    expect(
      (
        await tool.run(
          { url: "https://example.test/capped", path: "x.json" },
          { projectDir: dir, abortSignal: signal },
        )
      ).errorMessage,
    ).toContain("truncated");

    cache.set("https://example.test/html", {
      body: "# Not JSON",
      finalUrl: "https://example.test/html",
      complete: true,
    });
    expect(
      (
        await tool.run(
          { url: "https://example.test/html", path: "x.json" },
          { projectDir: dir, abortSignal: signal },
        )
      ).errorMessage,
    ).toContain("not valid JSON");
  });
});
