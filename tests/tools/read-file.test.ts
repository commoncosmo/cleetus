import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileBridge } from "../../src/acp/file-bridge";
import { ReadFileTool } from "../../src/tools/read-file";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-read-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ReadFileTool", () => {
  const tool = new ReadFileTool();

  it("returns file content", async () => {
    const path = join(dir, "a.txt");
    await writeFile(path, "hello\nworld\n");
    const r = await tool.run({ path }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hello");
    expect(r.output).toContain("world");
  });

  it("respects offset and limit", async () => {
    const path = join(dir, "b.txt");
    await writeFile(path, "a\nb\nc\nd\ne\n");
    const r = await tool.run({ path, offset: 2, limit: 2 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("b");
    expect(r.output).toContain("c");
    expect(r.output).not.toContain("a");
    expect(r.output).not.toContain("d");
  });

  it("returns TOOL_FAILED on missing file", async () => {
    const r = await tool.run({ path: join(dir, "nope.txt") }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("TOOL_FAILED");
  });

  it("returns raw file content with no note prepended", async () => {
    const path = join(dir, "d.txt");
    await writeFile(path, "BODY");
    const r = await tool.run({ path }, ctx());
    expect(r.output).toBe("BODY");
  });
});

describe("ReadFileTool path grounding (#114)", () => {
  const tool = new ReadFileTool();

  it("documents relative-to-working-directory paths, not absolute reconstruction", () => {
    const desc = (tool.parameters.properties.path as { description: string }).description;
    // The tool resolves relative paths against projectDir, so demanding an absolute path
    // forced weak workers to retype (and mangle) the project root — the #114 thrash.
    expect(desc.toLowerCase()).toContain("relative");
    expect(desc).not.toContain("Absolute path to the file");
  });

  it("resolves a relative path against the project dir", async () => {
    await writeFile(join(dir, "note.txt"), "REL");
    const r = await tool.run({ path: "note.txt" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("REL");
  });
});

describe("ReadFileTool FileBridge seam", () => {
  it("default constructor reads real disk (TUI path unchanged)", async () => {
    const path = join(dir, "disk.txt");
    await writeFile(path, "disk-content");
    const tool = new ReadFileTool();
    const r = await tool.run({ path }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("disk-content");
  });

  it("uses an injected stub FileBridge when provided", async () => {
    const stub: FileBridge = {
      readTextFile: async (_p) => "stub-content",
      writeTextFile: async (_p, _c) => {},
    };
    const tool = new ReadFileTool(stub);
    const r = await tool.run({ path: "any.txt" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("stub-content");
  });
});

describe("ReadFileTool EISDIR hint (#157)", () => {
  const tool = new ReadFileTool();

  it("returns an actionable message pointing at glob when given a directory", async () => {
    const r = await tool.run({ path: dir }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("is a directory");
    expect(r.errorMessage).toContain("glob");
  });

  it("reads a real file unchanged", async () => {
    const path = join(dir, "a.txt");
    await writeFile(path, "hello");
    const r = await tool.run({ path }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toBe("hello");
  });

  it("leaves a missing-file error as the raw message (no directory hint)", async () => {
    const r = await tool.run({ path: join(dir, "nope.txt") }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).not.toContain("is a directory");
  });
});
