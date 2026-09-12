import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { MAX_FILE_BYTES, enumerateFiles } from "../../src/codeindex/enumerate";

describe("enumerateFiles", () => {
  it("returns tracked source and excludes gitignored files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-enum-"));
    await $`git init`.cwd(dir).quiet();
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n");
    await writeFile(join(dir, ".gitignore"), "ignored.ts\n");
    await writeFile(join(dir, "ignored.ts"), "secret\n");
    await $`git add a.ts src/b.ts .gitignore`.cwd(dir).quiet();
    const files = await enumerateFiles(dir);
    expect(files.sort()).toEqual([".gitignore", "a.ts", "src/b.ts"]);
    expect(files).not.toContain("ignored.ts");
    await rm(dir, { recursive: true, force: true });
  });

  it("skips binary and oversized files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-enum-"));
    await $`git init`.cwd(dir).quiet();
    await writeFile(join(dir, "text.ts"), "ok\n");
    await writeFile(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3, 4]));
    await writeFile(join(dir, "big.txt"), "x".repeat(MAX_FILE_BYTES + 1));
    await $`git add -A`.cwd(dir).quiet();
    const files = await enumerateFiles(dir);
    expect(files).toContain("text.ts");
    expect(files).not.toContain("bin.dat");
    expect(files).not.toContain("big.txt");
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to glob with an ignore list when not a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-enum-nogit-"));
    await writeFile(join(dir, "a.ts"), "ok\n");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep.js"), "junk\n");
    const files = await enumerateFiles(dir);
    expect(files).toContain("a.ts");
    expect(files).not.toContain("node_modules/dep.js");
    await rm(dir, { recursive: true, force: true });
  });

  it("excludes ignored directories even when they are git-tracked (no .gitignore)", async () => {
    // Regression: a git repo that committed its node_modules/dist (no .gitignore) must NOT have the
    // whole dependency tree scanned at startup. `git ls-files` returns those paths, so the ignore
    // prune has to apply to the git candidate list too — not just the non-git glob fallback.
    // Observed in rvite/stuff2: 20,969 node_modules files, a 45s enumerate.
    const dir = await mkdtemp(join(tmpdir(), "cleetus-enum-gitnm-"));
    await $`git init`.cwd(dir).quiet();
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "junk\n");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist", "bundle.js"), "built\n");
    await $`git add -A`.cwd(dir).quiet();
    const files = await enumerateFiles(dir);
    expect(files).toContain("a.ts");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.startsWith("dist/"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("prunes ignored directories at ANY depth (non-git multi-project dir)", async () => {
    // Regression: a non-git parent holding built JS sub-projects. The ignore list must prune
    // node_modules/dist/.git nested under sub-projects, not just at the root — otherwise startup
    // reads ~every node_modules file (observed: 30,600 junk files, 82s scan).
    const dir = await mkdtemp(join(tmpdir(), "cleetus-enum-multi-"));
    for (const proj of ["app1", "app2"]) {
      await mkdir(join(dir, proj, "src"), { recursive: true });
      await writeFile(join(dir, proj, "src", "main.ts"), "export const x = 1;\n");
      await mkdir(join(dir, proj, "node_modules", "dep"), { recursive: true });
      await writeFile(join(dir, proj, "node_modules", "dep", "index.js"), "junk\n");
      await mkdir(join(dir, proj, "dist"), { recursive: true });
      await writeFile(join(dir, proj, "dist", "bundle.js"), "built\n");
    }
    const files = await enumerateFiles(dir);
    expect(files.sort()).toEqual(["app1/src/main.ts", "app2/src/main.ts"]);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes("dist/"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
