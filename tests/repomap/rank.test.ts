import { describe, expect, it } from "bun:test";
import { rankFiles } from "../../src/repomap/rank";
import type { FileSymbols } from "../../src/repomap/types";

const f = (path: string, n: number): FileSymbols => ({
  path,
  symbols: Array.from({ length: n }, (_, i) => ({ name: `s${i}`, kind: "function", line: i + 1 })),
});

describe("rankFiles", () => {
  it("orders by symbol count desc, then shallower path, then path asc", () => {
    const input = [f("a/b/deep.ts", 2), f("top.ts", 2), f("rich.ts", 5), f("a/early.ts", 2)];
    expect(rankFiles(input).map((x) => x.path)).toEqual([
      "rich.ts", // most symbols
      "top.ts", // tie at 2 → shallowest (1 segment)
      "a/early.ts", // 2 segments, "a/early" < "a/b/deep"
      "a/b/deep.ts",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [f("b.ts", 1), f("a.ts", 1)];
    const copy = [...input];
    rankFiles(input);
    expect(input).toEqual(copy);
  });
});
