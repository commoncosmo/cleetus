import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiEditTool } from "../../src/tools/multi-edit";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-multiedit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MultiEditTool", () => {
  const tool = new MultiEditTool();

  it("applies multiple edits in order and returns one before/after diff", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "alpha beta gamma");
    const r = await tool.run(
      {
        path,
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("ALPHA beta GAMMA");
    expect(r.diff).toEqual({ path, before: "alpha beta gamma", after: "ALPHA beta GAMMA" });
    expect(r.output).toContain("applied 2 edits");
    expect(r.output).toContain("(2 replacements)");
  });

  it("is atomic: if one edit fails, the file on disk is unchanged", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "alpha beta gamma");
    const r = await tool.run(
      {
        path,
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "zeta", newText: "Z" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("edit 2 of 2 failed: old_text not found");
    expect(await readFile(path, "utf8")).toBe("alpha beta gamma");
  });

  it("applies edits sequentially: a later edit can target an earlier edit's output", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "one");
    const r = await tool.run(
      {
        path,
        edits: [
          { oldText: "one", newText: "two" },
          { oldText: "two", newText: "three" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("three");
  });

  it("honors replace_all per edit and sums the replacement count", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "x x x | y");
    const r = await tool.run(
      {
        path,
        edits: [
          { oldText: "x", newText: "z", replaceAll: true },
          { oldText: "y", newText: "w" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("z z z | w");
    expect(r.output).toContain("(4 replacements)");
  });

  it("aborts on an ambiguous match without replace_all", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "x x x");
    const r = await tool.run({ path, edits: [{ oldText: "x", newText: "y" }] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("edit 1 of 1 failed: old_text matches 3 times; pass replace_all");
    expect(await readFile(path, "utf8")).toBe("x x x");
  });

  it("rejects an empty edits array", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "abc");
    const r = await tool.run({ path, edits: [] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("no edits provided");
  });

  it("rejects an edit whose new_text is missing, without corrupting the file", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "alpha beta");
    const r = await tool.run(
      { path, edits: [{ oldText: "alpha", newText: "A" }, { oldText: "beta" }] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("edit 2 of 2 failed: new_text must be a string");
    expect(await readFile(path, "utf8")).toBe("alpha beta"); // untouched
  });

  it("rejects an edit whose old_text is not a string", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "abc");
    const r = await tool.run({ path, edits: [{ newText: "b" }] }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBe("edit 1 of 1 failed: old_text must be a string");
    expect(await readFile(path, "utf8")).toBe("abc"); // untouched
  });

  it("returns an error when the file does not exist", async () => {
    const r = await tool.run(
      { path: join(dir, "missing.txt"), edits: [{ oldText: "a", newText: "b" }] },
      ctx(),
    );
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
  });

  it("accepts snake_case args (old_text/new_text/replace_all)", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "a a");
    const r = await tool.run(
      { path, edits: [{ old_text: "a", new_text: "b", replace_all: true }] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("b b");
  });

  it("serializes for the permission prompt", () => {
    expect(new MultiEditTool().serialize({ path: "src/x.ts", edits: [{}, {}] })).toBe(
      "multi_edit src/x.ts (2 edits)",
    );
    expect(new MultiEditTool().serialize({ path: "src/x.ts", edits: [{}] })).toBe(
      "multi_edit src/x.ts (1 edit)",
    );
  });

  it("tolerantly matches multi-line edits that differ only by indentation", async () => {
    const path = join(dir, "f.ts");
    await writeFile(path, "let a = 1;\n  let b = 2;\nlet c = 3;\n");
    const r = await tool.run(
      { path, edits: [{ old_text: "let a = 1;\nlet b = 2;", new_text: "let b = 9;" }] },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/ignoring indentation/);
    expect(await readFile(path, "utf8")).toBe("let b = 9;\nlet c = 3;\n");
  });

  it("annotates output when an edit matched ignoring indentation", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "a\n  b\nc\n");
    const r = await tool.run({ path, edits: [{ old_text: "\tb", new_text: "\tB" }] }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/ignoring indentation/);
    expect(await readFile(path, "utf8")).toBe("a\n  B\nc\n");
  });

  it("multi_edit output includes the changed region", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "a\nb\nc\nd");
    const r = await tool.run(
      {
        path,
        edits: [
          { old_text: "b", new_text: "X" },
          { old_text: "d", new_text: "Y" },
        ],
      },
      ctx(),
    );
    expect(r.ok).toBe(true);
    const out = (r as { output: string }).output;
    expect(out).toContain("2\tX");
    expect(out).toContain("4\tY");
  });
});
