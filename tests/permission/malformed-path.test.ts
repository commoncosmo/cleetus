import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  detectMalformedProjectPath,
  detectMalformedToolPath,
  extractGuardedPath,
} from "../../src/permission/malformed-path";

const ROOT = "/Users/example/source/own/north/sample-app";
// statDir stub: the project's own dir and its src/ subdir "exist"; nothing else does.
const statDir = async (d: string) => d === ROOT || d === join(ROOT, "src");

describe("detectMalformedProjectPath — forensic strings (#106)", () => {
  it("space injected into the root segment → src/App.tsx", async () => {
    const hit = await detectMalformedProjectPath(
      "/Users/example/source/own/north/f sample-app/src/App.tsx",
      ROOT,
      statDir,
    );
    expect(hit?.suggestion).toBe(join(ROOT, "src/App.tsx"));
  });

  it("space + case flip, file at root → tsconfig.json", async () => {
    const hit = await detectMalformedProjectPath(
      "/Users/example/source/own/north/f Sample-app/tsconfig.json",
      ROOT,
      statDir,
    );
    expect(hit?.suggestion).toBe(join(ROOT, "tsconfig.json"));
  });

  it("ancestor-segment insertion (corruption ABOVE the basename) is not caught → null", async () => {
    // The base segment 'sample-app' is clean; only a higher segment 'n | north' is corrupted.
    // Deliberately falls through to the normal out-of-tree prompt to keep zero false positives.
    expect(
      await detectMalformedProjectPath(
        "/Users/example/source/own/north/n | north/sample-app/src/index.css",
        ROOT,
        statDir,
      ),
    ).toBeNull();
  });

  it("path restarted mid-string (embedded absolute root) → src/App.css", async () => {
    const hit = await detectMalformedProjectPath(
      "/Users/example/source/own/north/f /Users/example/source/own/north/sample-app/src/App.css",
      ROOT,
      statDir,
    );
    expect(hit?.suggestion).toBe(join(ROOT, "src/App.css"));
  });
});

describe("detectMalformedProjectPath — no false positives", () => {
  it("clean in-project path → null (escape gate)", async () => {
    expect(await detectMalformedProjectPath(join(ROOT, "src/App.tsx"), ROOT, statDir)).toBeNull();
  });

  it("legit external path, no <base>/<tail> anchor → null", async () => {
    expect(
      await detectMalformedProjectPath("/Users/example/other/notes.txt", ROOT, statDir),
    ).toBeNull();
  });

  it("noisy external path with no anchor → null (noise alone never fires)", async () => {
    // A space in a legitimate external path must NOT trigger a bounce on its own.
    expect(
      await detectMalformedProjectPath("/Users/example/My Documents/notes.txt", ROOT, statDir),
    ).toBeNull();
  });

  it("legit relative sibling dir → null", async () => {
    expect(await detectMalformedProjectPath("../sibling/x.ts", ROOT, statDir)).toBeNull();
  });

  it("sibling dir whose name embeds the basename as a non-segment substring → null", async () => {
    // 'sample-app' appears only inside 'sample-app-backup', so the anchor 'sample-app/src/App.tsx'
    // is NOT present in the raw path → no hit.
    expect(
      await detectMalformedProjectPath(
        "/Users/example/source/own/north/sample-app-backup/src/App.tsx",
        ROOT,
        statDir,
      ),
    ).toBeNull();
  });

  it("clean same-basename twin project (anchor present, no corruption signature) → null", async () => {
    // A different real project also named 'sample-app', addressed cleanly: anchor matches but
    // there is no injected noise and no embedded root → must not fire.
    expect(
      await detectMalformedProjectPath("/tmp/sample-app/src/App.tsx", ROOT, statDir),
    ).toBeNull();
  });

  it("legit spacey external dir routing through a same-named folder → null (#106 FP fix)", async () => {
    // ~/Google Drive/sample-app/notes.txt: the <base> segment 'sample-app' is CLEAN; the only
    // noise is in 'Google Drive', an unrelated external dir. Must not be bounced.
    expect(
      await detectMalformedProjectPath(
        "/Users/example/Google Drive/sample-app/notes.txt",
        ROOT,
        statDir,
      ),
    ).toBeNull();
  });
});

describe("extractGuardedPath", () => {
  it("returns the path arg for read_file and write tools", () => {
    expect(extractGuardedPath("read_file", { path: "a.ts" })).toBe("a.ts");
    expect(extractGuardedPath("write_file", { path: "b.ts", content: "" })).toBe("b.ts");
    expect(extractGuardedPath("edit_file", { path: "c.ts" })).toBe("c.ts");
  });

  it("returns cwd for glob, null when glob has no cwd", () => {
    expect(extractGuardedPath("glob", { pattern: "*.ts", cwd: "src" })).toBe("src");
    expect(extractGuardedPath("glob", { pattern: "*.ts" })).toBeNull();
  });

  it("returns null for a tool with no path arg", () => {
    expect(extractGuardedPath("bash", { command: "ls" })).toBeNull();
  });
});

describe("detectMalformedToolPath — read/glob coverage", () => {
  it("flags a leading-slash read when the absolute parent is absent and project parent exists", async () => {
    const hit = await detectMalformedToolPath("read_file", { path: "/src/App.tsx" }, ROOT, statDir);
    expect(hit?.suggestion).toBe(join(ROOT, "src/App.tsx"));
  });

  it("does not rewrite a leading-slash read when its absolute parent exists", async () => {
    const withExternalSrc = async (dir: string) => dir === "/src" || statDir(dir);
    expect(
      await detectMalformedToolPath("read_file", { path: "/src/App.tsx" }, ROOT, withExternalSrc),
    ).toBeNull();
  });

  it("does not reinterpret an absolute write as project-relative", async () => {
    expect(
      await detectMalformedToolPath(
        "write_file",
        { path: "/src/App.tsx", content: "" },
        ROOT,
        statDir,
      ),
    ).toBeNull();
  });

  it("flags a malformed read_file path", async () => {
    const hit = await detectMalformedToolPath(
      "read_file",
      { path: "/Users/example/source/own/north/f sample-app/src/App.tsx" },
      ROOT,
      statDir,
    );
    expect(hit?.suggestion).toBe(join(ROOT, "src/App.tsx"));
  });

  it("flags a malformed glob cwd (in-base-segment noise)", async () => {
    const hit = await detectMalformedToolPath(
      "glob",
      { pattern: "*.css", cwd: "/Users/example/source/own/north/f sample-app/src" },
      ROOT,
      statDir,
    );
    expect(hit?.suggestion).toBe(join(ROOT, "src"));
  });

  it("returns null for a tool with no path arg", async () => {
    expect(await detectMalformedToolPath("bash", { command: "ls" }, ROOT, statDir)).toBeNull();
  });
});
