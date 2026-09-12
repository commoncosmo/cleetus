import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileBridge } from "../../src/acp/file-bridge";
import { WriteFileTool } from "../../src/tools/write-file";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-write-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("WriteFileTool", () => {
  const tool = new WriteFileTool();
  it("writes content and creates parent dirs", async () => {
    const path = join(dir, "sub", "x.txt");
    const r = await tool.run({ path, content: "hi" }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("hi");
  });
  it("overwrites existing", async () => {
    const path = join(dir, "y.txt");
    await tool.run({ path, content: "first" }, ctx());
    await tool.run({ path, content: "second" }, ctx());
    expect(await readFile(path, "utf8")).toBe("second");
  });
  it("returns a before/after snapshot capturing prior content", async () => {
    const path = join(dir, "f.txt");
    await writeFile(path, "old content\n");
    const r = await tool.run({ path, content: "new content\n" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.diff).toEqual({
      path,
      before: "old content\n",
      after: "new content\n",
      created: false,
    });
  });

  it("uses an empty before for a new file", async () => {
    const path = join(dir, "new.txt");
    const r = await tool.run({ path, content: "hello\n" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.diff).toEqual({ path, before: "", after: "hello\n", created: true });
  });

  it("refuses an absolute path outside the project with guidance", async () => {
    const r = await tool.run({ path: "/Users/jj/repos/dashboard/x.txt", content: "hi" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain("outside the project root");
  });

  it("default constructor writes real disk (TUI path unchanged)", async () => {
    const path = join(dir, "disk-write.txt");
    const tool = new WriteFileTool();
    const r = await tool.run({ path, content: "disk-data" }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("disk-data");
  });

  it("uses an injected stub FileBridge when provided", async () => {
    const written: { path: string; content: string }[] = [];
    const stub: FileBridge = {
      readTextFile: async (_p) => {
        throw Object.assign(new Error("stub"), { code: "ENOENT" });
      },
      writeTextFile: async (p, c) => {
        written.push({ path: p, content: c });
      },
    };
    const tool = new WriteFileTool(stub);
    const path = join(dir, "stub-out.txt");
    const r = await tool.run({ path, content: "stub-data" }, ctx());
    expect(r.ok).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]?.content).toBe("stub-data");
  });

  it("writes outside the project when allowOutsideProject is set", async () => {
    const outside = join(dir, "..", `cleetus-out-${Date.now()}.txt`);
    const r = await tool.run(
      { path: outside, content: "ok" },
      { projectDir: dir, abortSignal: new AbortController().signal, allowOutsideProject: true },
    );
    expect(r.ok).toBe(true);
    await rm(outside, { force: true });
  });
});
