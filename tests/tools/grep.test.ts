import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
  it("uses the built-in fallback without spawning Bash when ripgrep is missing", async () => {
    const spawn = spyOn(Bun, "spawn");
    try {
      const tool = new GrepTool(() => null);
      const result = await tool.run({ pattern: "function" }, ctx());
      expect(result.ok).toBe(true);
      expect(result.output).toContain("a.ts");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });
  it.skipIf(!Bun.which("rg"))(
    "launches resolved ripgrep directly, without a discovery shell",
    async () => {
      const executable = Bun.which("rg")!;
      const names: string[] = [];
      const spawn = spyOn(Bun, "spawn");
      try {
        const tool = new GrepTool((name) => {
          names.push(name);
          return executable;
        });
        const result = await tool.run({ pattern: "function" }, ctx());
        expect(result.ok).toBe(true);
        expect(result.output).toContain("a.ts");
        expect(names).toEqual(["rg"]);
        expect(spawn.mock.calls).toHaveLength(1);
        expect((spawn.mock.calls[0]?.[0] as string[])[0]).toBe(executable);
      } finally {
        spawn.mockRestore();
      }
    },
  );
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
