import { describe, expect, it } from "bun:test";
import { type HunkLine, parsePatch, patchTargetPath } from "../../../src/tools/apply-patch/parse";

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const ctx = (text: string): HunkLine => ({ kind: "context", text });
const del = (text: string): HunkLine => ({ kind: "del", text });
const add = (text: string): HunkLine => ({ kind: "add", text });

describe("parsePatch", () => {
  it("parses an Update File with one hunk (preserving line ops in order)", () => {
    const r = parsePatch(wrap("*** Update File: src/foo.ts\n@@\n a\n-b\n+B\n c"));
    expect(r).toEqual({
      op: "update",
      path: "src/foo.ts",
      hunks: [{ lines: [ctx("a"), del("b"), add("B"), ctx("c")] }],
    });
  });

  it("parses multiple hunks in an Update File", () => {
    const r = parsePatch(wrap("*** Update File: a.ts\n@@\n x\n-y\n+Y\n@@\n-p\n+P\n q"));
    expect(r).toEqual({
      op: "update",
      path: "a.ts",
      hunks: [{ lines: [ctx("x"), del("y"), add("Y")] }, { lines: [del("p"), add("P"), ctx("q")] }],
    });
  });

  it("treats an unprefixed non-empty line as context (lenient)", () => {
    const r = parsePatch(wrap("*** Update File: a.ts\n@@\nctx\n-old\n+new"));
    expect(r).toEqual({
      op: "update",
      path: "a.ts",
      hunks: [{ lines: [ctx("ctx"), del("old"), add("new")] }],
    });
  });

  it("parses an Add File", () => {
    const r = parsePatch(wrap("*** Add File: new.ts\n+line1\n+line2"));
    expect(r).toEqual({ op: "add", path: "new.ts", lines: ["line1", "line2"] });
  });

  it("rejects a patch with no Begin/End envelope", () => {
    expect("error" in parsePatch("*** Update File: a.ts\n+x")).toBe(true);
  });

  it("rejects multiple file sections", () => {
    const r = parsePatch(wrap("*** Update File: a.ts\n-x\n+y\n*** Update File: b.ts\n-p\n+q"));
    expect("error" in r).toBe(true);
  });

  it("rejects Delete File with a clear message", () => {
    const r = parsePatch(wrap("*** Delete File: a.ts"));
    expect((r as { error: string }).error.toLowerCase()).toContain("delete");
  });

  it("rejects an empty/garbage patch", () => {
    expect("error" in parsePatch("nonsense")).toBe(true);
  });

  it("rejects a file header with a blank path", () => {
    const r = parsePatch(wrap("*** Update File:   \n-a\n+b"));
    expect((r as { error: string }).error.toLowerCase()).toContain("path");
  });

  it("keeps a blank line in an Add File as blank content", () => {
    const r = parsePatch(wrap("*** Add File: new.ts\n+a\n\n+b"));
    expect(r).toEqual({ op: "add", path: "new.ts", lines: ["a", "", "b"] });
  });
});

describe("patchTargetPath", () => {
  it("extracts the Update File path", () => {
    expect(patchTargetPath(wrap("*** Update File: src/x.ts\n-a\n+b"))).toBe("src/x.ts");
  });
  it("extracts the Add File path", () => {
    expect(patchTargetPath(wrap("*** Add File: y.ts\n+a"))).toBe("y.ts");
  });
  it("returns null when there is no file header", () => {
    expect(patchTargetPath("nope")).toBeNull();
  });
  it("returns null for a Delete File header (not an Update/Add target)", () => {
    expect(patchTargetPath(wrap("*** Delete File: a.ts"))).toBeNull();
  });
});
