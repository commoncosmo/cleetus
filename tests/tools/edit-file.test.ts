import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditFileTool } from "../../src/tools/edit-file";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-edit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("EditFileTool", () => {
  const tool = new EditFileTool();
  it("replaces a single unique occurrence", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "alpha beta gamma");
    const r = await tool.run({ path, oldText: "beta", newText: "BETA" }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("alpha BETA gamma");
  });
  it("fails when oldText not found", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "abc");
    const r = await tool.run({ path, oldText: "xyz", newText: "x" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/not found/i);
  });
  it("fails when oldText is not unique unless replaceAll true", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "x x x");
    const r1 = await tool.run({ path, oldText: "x", newText: "y" }, ctx());
    expect(r1.ok).toBe(false);
    const r2 = await tool.run({ path, oldText: "x", newText: "y", replaceAll: true }, ctx());
    expect(r2.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("y y y");
  });
  it("inserts newText literally even when it contains $ substitution patterns", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "price: AMOUNT");
    const r = await tool.run({ path, oldText: "AMOUNT", newText: "$&100 $1 $`" }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("price: $&100 $1 $`");
  });
  it("returns a before/after diff snapshot on success", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "alpha\nbeta\ngamma\n");
    const r = await tool.run({ path, oldText: "beta", newText: "BETA" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.diff).toEqual({
      path,
      before: "alpha\nbeta\ngamma\n",
      after: "alpha\nBETA\ngamma\n",
    });
  });

  it("tolerantly matches when old_text differs only by indentation", async () => {
    const path = join(dir, "f.ts");
    await writeFile(path, "function foo() {\n  return 1;\n}\n");
    const r = await tool.run(
      { path, oldText: "function foo() {\nreturn 1;\n}", newText: "x" },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/matched ignoring indentation/);
    expect(await readFile(path, "utf8")).toBe("x\n");
  });

  it("does not attach a hint on a successful edit", async () => {
    const path = join(dir, "g.txt");
    await writeFile(path, "alpha beta gamma");
    const r = await tool.run({ path, oldText: "beta", newText: "BETA" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output ?? "").not.toContain("whitespace");
  });

  it("annotates the output when it matched ignoring indentation", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "fn() {\n  body\n}\n");
    const r = await tool.run({ path, oldText: "\tbody", newText: "\tBODY" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/matched ignoring indentation/);
    expect(await readFile(path, "utf8")).toBe("fn() {\n  BODY\n}\n");
  });

  it("surfaces actionable guidance when a whitespace-only block is ambiguous", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "  q\n    q\n");
    const r = await tool.run({ path, oldText: "\tq", newText: "z" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toMatch(/ignoring indentation/);
  });

  it("edit_file output includes the changed region", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "a\nb\nc\nd\ne");
    const r = await tool.run({ path, oldText: "c", newText: "Z" }, ctx());
    expect(r.ok).toBe(true);
    expect((r as { output: string }).output).toContain("3\tZ");
  });
});
