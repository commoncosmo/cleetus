import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/memory/store";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-mem-"));
  path = join(dir, "memory.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("returns [] when the file is missing", () => {
    expect(new MemoryStore(path).list()).toEqual([]);
  });

  it("add then list round-trips in order, creating the file", () => {
    const s = new MemoryStore(path);
    s.add("I use bun");
    s.add("conventional commits");
    expect(s.list()).toEqual(["I use bun", "conventional commits"]);
  });

  it("exposes the file path it writes to", () => {
    expect(new MemoryStore(path).path).toBe(path);
  });

  it("add creates a missing parent directory", () => {
    const s = new MemoryStore(join(dir, "deep", "memory.md"));
    s.add("x");
    expect(s.list()).toEqual(["x"]);
  });

  it("collapses a multi-line memory into one bullet", () => {
    const s = new MemoryStore(path);
    s.add("line one\nline two");
    expect(s.list()).toEqual(["line one line two"]);
  });

  it("ignores blank and non-bullet lines", async () => {
    await writeFile(path, "# header\n\n- real memory\nnot a bullet\n");
    expect(new MemoryStore(path).list()).toEqual(["real memory"]);
  });

  it("removeAt removes the right bullet and returns true", () => {
    const s = new MemoryStore(path);
    s.add("a");
    s.add("b");
    s.add("c");
    expect(s.removeAt(1)).toBe(true);
    expect(s.list()).toEqual(["a", "c"]);
  });

  it("removeAt out of range returns false and leaves the list unchanged", () => {
    const s = new MemoryStore(path);
    s.add("a");
    expect(s.removeAt(5)).toBe(false);
    expect(s.list()).toEqual(["a"]);
  });

  it("removeAt preserves non-bullet lines", async () => {
    await writeFile(path, "# header\n- a\n- b\n");
    const s = new MemoryStore(path);
    s.removeAt(0);
    expect(await readFile(path, "utf8")).toContain("# header");
    expect(s.list()).toEqual(["b"]);
  });

  it("ignores an empty add", () => {
    const s = new MemoryStore(path);
    s.add("   ");
    expect(s.list()).toEqual([]);
  });

  it("removeAt does not leave a leading blank line", async () => {
    await writeFile(path, "- a\n\n- b\n");
    const s = new MemoryStore(path);
    s.removeAt(0);
    expect((await readFile(path, "utf8")).startsWith("\n")).toBe(false);
    expect(s.list()).toEqual(["b"]);
  });
});
