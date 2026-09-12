import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoMap } from "../../src/repomap/build";
import type { RepoMapCache } from "../../src/repomap/types";

let dir: string;
const cachePath = () => join(dir, ".cleetus", "repomap.json");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-repomap-build-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildRepoMap", () => {
  it("maps a directory of source files and writes a cache", async () => {
    await writeFile(join(dir, "a.ts"), "export function alpha() {}");
    await writeFile(join(dir, "b.py"), "def beta():\n    pass");
    const out = await buildRepoMap({ projectDir: dir, tokenBudget: 1000, cachePath: cachePath() });
    expect(out).toContain("## Repository map");
    expect(out).toContain("a.ts");
    expect(out).toContain("alpha (function) :1");
    expect(out).toContain("b.py");
    expect(out).toContain("beta (function) :1");
    const cache: RepoMapCache = JSON.parse(await readFile(cachePath(), "utf8"));
    expect(Object.keys(cache).sort()).toEqual(["a.ts", "b.py"]);
  });

  it("reuses cached symbols for unchanged files and re-extracts changed ones", async () => {
    const aPath = join(dir, "a.ts");
    await writeFile(aPath, "export function alpha() {}");
    await buildRepoMap({ projectDir: dir, tokenBudget: 1000, cachePath: cachePath() });
    const firstCache: RepoMapCache = JSON.parse(await readFile(cachePath(), "utf8"));
    const firstHash = firstCache["a.ts"]!.hash;

    await writeFile(aPath, "export function alphaRenamed() {}");
    const out = await buildRepoMap({ projectDir: dir, tokenBudget: 1000, cachePath: cachePath() });
    expect(out).toContain("alphaRenamed (function) :1");
    const secondCache: RepoMapCache = JSON.parse(await readFile(cachePath(), "utf8"));
    expect(secondCache["a.ts"]!.hash).not.toBe(firstHash);
  });

  it("prunes cache entries for deleted files", async () => {
    await writeFile(join(dir, "a.ts"), "export const a = 1;");
    await writeFile(join(dir, "b.ts"), "export const b = 2;");
    await buildRepoMap({ projectDir: dir, tokenBudget: 1000, cachePath: cachePath() });
    await rm(join(dir, "b.ts"));
    await buildRepoMap({ projectDir: dir, tokenBudget: 1000, cachePath: cachePath() });
    const cache: RepoMapCache = JSON.parse(await readFile(cachePath(), "utf8"));
    expect(Object.keys(cache)).toEqual(["a.ts"]);
  });
});
