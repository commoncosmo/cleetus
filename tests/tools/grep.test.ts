import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrepTool } from "../../src/tools/grep";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-grep-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "function foo() {}\n");
  await writeFile(join(dir, "src", "b.ts"), "const bar = 1;\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("GrepTool", () => {
  const tool = new GrepTool();
  it("finds matches across files", async () => {
    const r = await tool.run({ pattern: "function" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("a.ts");
    expect(r.output).toContain("function foo");
  });

  it("scopes by path", async () => {
    const r = await tool.run({ pattern: "const", path: "src" }, ctx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("b.ts");
  });

  it("grep: zero matches returns an explicit no-match message", async () => {
    const result = await tool.run({ pattern: "zqxjklmnopvwy_never_present" }, ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe(
        "no matches for pattern 'zqxjklmnopvwy_never_present'. Try a broader pattern, ignore_case, or a different directory.",
      );
    }
  });
});
