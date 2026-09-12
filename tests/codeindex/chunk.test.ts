import { describe, expect, it } from "bun:test";
import { chunkFile } from "../../src/codeindex/chunk";

describe("chunkFile", () => {
  it("returns one chunk for a short file", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const chunks = chunkFile("a.ts", content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("a.ts#0");
    expect(chunks[0]!.metadata).toEqual({ path: "a.ts", startLine: 1, endLine: 10 });
    expect(chunks[0]!.text).toBe(content);
  });

  it("windows a long file with overlap and correct line ranges", () => {
    const content = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n");
    const chunks = chunkFile("b.ts", content);
    expect(chunks.map((c) => [c.metadata.startLine, c.metadata.endLine])).toEqual([
      [1, 40],
      [33, 72],
      [65, 100],
    ]);
    expect(chunks.map((c) => c.id)).toEqual(["b.ts#0", "b.ts#1", "b.ts#2"]);
  });

  it("returns no chunks for an empty or whitespace-only file", () => {
    expect(chunkFile("e.ts", "")).toEqual([]);
    expect(chunkFile("e.ts", "   \n  \n")).toEqual([]);
  });

  it("ignores a single trailing newline in line counting", () => {
    const chunks = chunkFile("c.ts", "a\nb\nc\n");
    expect(chunks[0]!.metadata).toEqual({ path: "c.ts", startLine: 1, endLine: 3 });
    expect(chunks[0]!.text).toBe("a\nb\nc");
  });

  it("strips multiple trailing newlines from the final chunk", () => {
    const chunks = chunkFile("d.ts", "a\nb\n\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.metadata).toEqual({ path: "d.ts", startLine: 1, endLine: 2 });
    expect(chunks[0]!.text).toBe("a\nb");
  });
});
