import { describe, expect, it } from "bun:test";
import { estimateTokens, renderMap, truncateMapToBudget } from "../../src/repomap/render";
import type { FileSymbols } from "../../src/repomap/types";

describe("renderMap", () => {
  it("renders header, paths, and indented symbols", () => {
    const files: FileSymbols[] = [
      { path: "a.ts", symbols: [{ name: "Foo", kind: "class", line: 3 }] },
      { path: "b.py", symbols: [] },
    ];
    expect(renderMap(files, 1000)).toBe(
      ["## Repository map", "a.ts", "  Foo (class) :3", "b.py"].join("\n"),
    );
  });

  it("returns '' for no files", () => {
    expect(renderMap([], 1000)).toBe("");
  });

  it("truncates to budget and appends a '… N more files' tail", () => {
    const files: FileSymbols[] = Array.from({ length: 50 }, (_, i) => ({
      path: `file${i}.ts`,
      symbols: [{ name: `Sym${i}`, kind: "function", line: 1 }],
    }));
    const out = renderMap(files, 30); // tiny budget
    expect(out.startsWith("## Repository map")).toBe(true);
    expect(out).toMatch(/… \d+ more files$/);
    // Far fewer than 50 files rendered.
    expect(out.split("\n").length).toBeLessThan(20);
  });

  it("always includes at least one file even if it alone exceeds the budget", () => {
    const files: FileSymbols[] = [
      {
        path: "huge.ts",
        symbols: Array.from({ length: 40 }, (_, i) => ({
          name: `s${i}`,
          kind: "function",
          line: i + 1,
        })),
      },
      { path: "next.ts", symbols: [] },
    ];
    const out = renderMap(files, 1);
    expect(out).toContain("huge.ts");
    expect(out).toMatch(/… 1 more files$/);
  });
});

describe("estimateTokens", () => {
  it("is chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("truncateMapToBudget", () => {
  const map = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts:\n  fn symbol${i}()`).join(
    "\n",
  );

  it("returns the map unchanged when it fits", () => {
    expect(truncateMapToBudget(map, estimateTokens(map) + 10)).toBe(map);
  });
  it("cuts on line boundaries and respects the budget", () => {
    const cut = truncateMapToBudget(map, 50);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(50);
    expect(map.startsWith(cut)).toBe(true);
    expect(cut.length).toBeGreaterThan(0);
  });
  it("empty map stays empty", () => {
    expect(truncateMapToBudget("", 100)).toBe("");
  });
});
