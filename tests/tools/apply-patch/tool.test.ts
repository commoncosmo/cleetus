import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyPatchTool } from "../../../src/tools/apply-patch/tool";

let dir: string;
const ctx = () => ({ projectDir: dir, abortSignal: new AbortController().signal });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-applypatch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe("ApplyPatchTool", () => {
  const tool = new ApplyPatchTool();

  it("is flagged as mutating", () => {
    expect(tool.mutates).toBe(true);
  });

  it("updates an existing file and returns a diff", async () => {
    const path = join(dir, "f.ts");
    await writeFile(path, "a\nb\nc\n");
    const r = await tool.run(
      { patch: wrap(`*** Update File: ${path}\n@@\n a\n-b\n+B\n c`) },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("a\nB\nc\n");
    expect(r.diff).toEqual({ path, before: "a\nb\nc\n", after: "a\nB\nc\n", created: false });
  });

  it("adds a new file with created:true", async () => {
    const path = join(dir, "new.ts");
    const r = await tool.run({ patch: wrap(`*** Add File: ${path}\n+hello\n+world`) }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("hello\nworld\n");
    expect(r.diff?.created).toBe(true);
  });

  it("errors when Add targets an existing file", async () => {
    const path = join(dir, "exists.ts");
    await writeFile(path, "x");
    const r = await tool.run({ patch: wrap(`*** Add File: ${path}\n+y`) }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage?.toLowerCase()).toContain("already exists");
  });

  it("errors when Update targets a missing file", async () => {
    const path = join(dir, "ghost.ts");
    const r = await tool.run({ patch: wrap(`*** Update File: ${path}\n-a\n+b`) }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage?.toLowerCase()).toContain("not found");
  });

  it("applies a multi-hunk update through the tool", async () => {
    const path = join(dir, "m.ts");
    await writeFile(path, "x\ny\np\nq\n");
    const r = await tool.run(
      { patch: wrap(`*** Update File: ${path}\n@@\n x\n-y\n+Y\n@@\n-p\n+P\n q`) },
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("x\nY\nP\nq\n");
  });

  it("creates parent directories for an Add to a nested path", async () => {
    const path = join(dir, "deep", "nested", "n.ts");
    const r = await tool.run({ patch: wrap(`*** Add File: ${path}\n+hi`) }, ctx());
    expect(r.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("hi\n");
  });

  it("returns the parse error for a malformed patch", async () => {
    const r = await tool.run({ patch: "garbage" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toBeTruthy();
  });

  it("refuses a patch whose path escapes the project", async () => {
    const outside = join(dir, "..", `escape-${Date.now()}.ts`);
    const r = await tool.run({ patch: wrap(`*** Add File: ${outside}\n+x`) }, ctx());
    expect(r.ok).toBe(false);
    expect(r.errorMessage?.toLowerCase()).toContain("outside the project");
    expect(existsSync(outside)).toBe(false);
  });

  it("serialize names the file", () => {
    expect(tool.serialize({ patch: wrap("*** Update File: src/x.ts\n-a\n+b") })).toContain(
      "src/x.ts",
    );
  });
});
