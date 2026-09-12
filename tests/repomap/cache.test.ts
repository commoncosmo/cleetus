import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCache, saveCache } from "../../src/repomap/cache";
import type { RepoMapCache } from "../../src/repomap/types";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-repomap-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("repomap cache", () => {
  it("round-trips a cache through save/load", async () => {
    const path = join(dir, "nested", "repomap.json"); // dir does not exist yet
    const cache: RepoMapCache = {
      "a.ts": { hash: "h1", symbols: [{ name: "X", kind: "class", line: 1 }] },
    };
    await saveCache(path, cache);
    expect(await loadCache(path)).toEqual(cache);
  });

  it("returns {} for a missing file", async () => {
    expect(await loadCache(join(dir, "nope.json"))).toEqual({});
  });

  it("returns {} for malformed JSON", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json");
    expect(await loadCache(path)).toEqual({});
  });
});
