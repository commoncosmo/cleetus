import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobTool } from "../../src/tools/glob";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-glob-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "");
  await writeFile(join(dir, "src", "b.ts"), "");
  await writeFile(join(dir, "README.md"), "");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("GlobTool", () => {
  const tool = new GlobTool();
  it("finds files by pattern", async () => {
    const r = await tool.run({ pattern: "src/*.ts" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("a.ts");
    expect(r.output).toContain("b.ts");
    expect(r.output).not.toContain("README.md");
  });

  it("glob: zero matches returns an explicit no-match message", async () => {
    const result = await tool.run({ pattern: "**/*.zqxnope" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe(
        "no files match '**/*.zqxnope'. Broaden the pattern or set a different cwd.",
      );
    }
  });

  it("no-match message names the cwd argument", async () => {
    // Use the file's existing tool/ctx setup.
    const r = await tool.run({ pattern: "nope-*.xyz" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("no files match 'nope-*.xyz'");
    expect(r.output).toContain("cwd");
  });

  it("no-match message echoes an explicit cwd", async () => {
    const r = await tool.run({ pattern: "nope-*.xyz", cwd: "src" }, ctx());
    expect(r.output).toContain(" in src.");
  });
});
