import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  dirEscapesProject,
  pathEscapesProject,
  resolveReadTarget,
  resolveToolTargetPath,
  splitPatternPrefix,
  writeEscapesProject,
} from "../../src/permission/path-guard";

let project: string;
let outside: string;
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "cleetus-guard-"));
  project = join(root, "project");
  outside = join(root, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterEach(async () => {
  await rm(resolve(project, ".."), { recursive: true, force: true });
});

describe("writeEscapesProject", () => {
  it("returns false for an absolute path inside the project", async () => {
    expect(await writeEscapesProject("write_file", { path: join(project, "a.txt") }, project)).toBe(
      false,
    );
  });

  it("returns false for a nested path inside the project", async () => {
    expect(
      await writeEscapesProject(
        "write_file",
        { path: join(project, "sub", "deep", "a.txt") },
        project,
      ),
    ).toBe(false);
  });

  it("returns false for a relative path that stays inside", async () => {
    expect(await writeEscapesProject("write_file", { path: "sub/a.txt" }, project)).toBe(false);
  });

  it("returns true for an absolute path outside the project", async () => {
    expect(
      await writeEscapesProject("write_file", { path: join(outside, "evil.txt") }, project),
    ).toBe(true);
  });

  it("returns true for a ../ traversal escaping the project", async () => {
    expect(
      await writeEscapesProject(
        "write_file",
        { path: join(project, "..", "outside", "evil.txt") },
        project,
      ),
    ).toBe(true);
  });

  it("returns true when a symlinked subdir points outside the project", async () => {
    // project/link -> outside ; writing project/link/evil.txt actually lands in outside/
    await symlink(outside, join(project, "link"));
    expect(
      await writeEscapesProject("write_file", { path: join(project, "link", "evil.txt") }, project),
    ).toBe(true);
  });

  it("applies to edit_file as well", async () => {
    expect(
      await writeEscapesProject("edit_file", { path: join(outside, "evil.txt") }, project),
    ).toBe(true);
    expect(await writeEscapesProject("edit_file", { path: join(project, "ok.txt") }, project)).toBe(
      false,
    );
  });

  it("applies to exact fetched JSON saves", async () => {
    expect(
      await writeEscapesProject(
        "save_fetched_json",
        { url: "https://example.test/data", path: join(outside, "data.json") },
        project,
      ),
    ).toBe(true);
  });

  it("returns false for non-write tools regardless of path", async () => {
    expect(await writeEscapesProject("read_file", { path: join(outside, "x.txt") }, project)).toBe(
      false,
    );
    expect(await writeEscapesProject("bash", { command: "rm -rf /" }, project)).toBe(false);
    expect(await writeEscapesProject("glob", { pattern: "**/*" }, project)).toBe(false);
  });

  it("returns false (not a crash) when args has no usable path", async () => {
    expect(await writeEscapesProject("write_file", {}, project)).toBe(false);
    expect(await writeEscapesProject("write_file", { path: 123 }, project)).toBe(false);
    expect(await writeEscapesProject("write_file", null, project)).toBe(false);
  });

  it("handles writes to a non-existent top-level directory without path corruption", async () => {
    // projectDir is a real temp dir; target is a bogus top-level path that escapes.
    // Before the fix, realpathWithMissingParents would produce a //-prefixed path
    // (off-by-one when parent === "/"), causing the startsWith check to fail to
    // detect the escape. After the fix it must return true (escapes the project).
    const r = await writeEscapesProject(
      "write_file",
      { path: "/nonexistent_toplevel_xyz_999/file.txt" },
      project,
    );
    expect(r).toBe(true);
  });

  it("flags an apply_patch whose embedded path escapes the project", async () => {
    const patch = `*** Begin Patch\n*** Add File: ${join(outside, "evil.ts")}\n+x\n*** End Patch`;
    expect(await writeEscapesProject("apply_patch", { patch }, project)).toBe(true);
  });

  it("does not flag an in-project apply_patch", async () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n-a\n+b\n*** End Patch";
    expect(await writeEscapesProject("apply_patch", { patch }, project)).toBe(false);
  });

  it("does not flag an apply_patch with no extractable path", async () => {
    expect(await writeEscapesProject("apply_patch", { patch: "garbage" }, project)).toBe(false);
  });
});

describe("pathEscapesProject", () => {
  it("returns false for a relative path inside the project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-pg-"));
    expect(await pathEscapesProject("src/x.ts", dir)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("returns false for an absolute path inside the project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-pg-"));
    expect(await pathEscapesProject(join(dir, "src", "x.ts"), dir)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("returns true for an absolute path outside the project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-pg-"));
    expect(await pathEscapesProject("/Users/jj/repos/dashboard/x", dir)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("returns true for a ../ traversal escaping the project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-pg-"));
    expect(await pathEscapesProject("../../etc/passwd", dir)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("writeEscapesProject covers multi_edit", () => {
  it("flags an escaping multi_edit path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-pg-"));
    expect(await writeEscapesProject("multi_edit", { path: "/Users/jj/x" }, dir)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("resolveToolTargetPath", () => {
  it("resolves write tools' target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-pg-"));
    const root = await realpath(dir);
    expect(await resolveToolTargetPath("edit_file", { path: "a/b.ts" }, dir)).toBe(
      `${root}/a/b.ts`,
    );
    expect(await resolveToolTargetPath("write_file", { path: `${dir}/c.ts` }, dir)).toBe(
      `${root}/c.ts`,
    );
    expect(await resolveToolTargetPath("multi_edit", { path: "d/e.ts" }, dir)).toBe(
      `${root}/d/e.ts`,
    );
    expect(await resolveToolTargetPath("bash", { command: "ls" }, dir)).toBeNull();
    expect(await resolveToolTargetPath("edit_file", {}, dir)).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
  it("handles apply_patch's embedded path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-pg-"));
    const patch = "*** Begin Patch\n*** Update File: a/b.ts\n-x\n+y\n*** End Patch";
    expect(await resolveToolTargetPath("apply_patch", { patch }, dir)).toBe(
      `${await realpath(dir)}/a/b.ts`,
    );
    await rm(dir, { recursive: true, force: true });
  });
});

describe("dirEscapesProject", () => {
  let projectDir: string;
  beforeEach(async () => {
    // Must realpath so macOS /tmp→/private/tmp symlink doesn't cause mismatches.
    const raw = await mkdtemp(join(tmpdir(), "cleetus-dep-"));
    projectDir = await realpath(raw);
    await mkdir(join(projectDir, "sub"), { recursive: true });
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("returns false for the project root itself (absolute)", async () => {
    expect(await dirEscapesProject(projectDir, projectDir)).toBe(false);
  });

  it("returns false for '.' (relative = root)", async () => {
    expect(await dirEscapesProject(".", projectDir)).toBe(false);
  });

  it("returns false for an existing subdirectory (absolute)", async () => {
    expect(await dirEscapesProject(join(projectDir, "sub"), projectDir)).toBe(false);
  });

  it("returns false for a relative subdirectory path", async () => {
    expect(await dirEscapesProject("sub", projectDir)).toBe(false);
  });

  it("returns true for an absolute path clearly outside (/etc)", async () => {
    expect(await dirEscapesProject("/etc", projectDir)).toBe(true);
  });

  it("returns true for a ../sibling relative escape", async () => {
    expect(await dirEscapesProject("../sibling", projectDir)).toBe(true);
  });
});

describe("resolveReadTarget", () => {
  // The syscall-free guarantee for non-read tools (early return before any realpath call) is
  // pinned in tests/permission/path-guard-syscall.test.ts via a realpath spy; this test only
  // checks the return value.
  it("null for non-read tools", async () => {
    expect(await resolveReadTarget("bash", { command: "ls" }, "/tmp")).toBeNull();
    expect(await resolveReadTarget("write_file", { path: "x" }, "/tmp")).toBeNull();
  });

  it("in-project read does not escape", async () => {
    const r = await resolveReadTarget("read_file", { path: "src/app.ts" }, process.cwd());
    expect(r?.escapes).toBe(false);
  });

  it("missing glob cwd / grep path default to the project (no escape)", async () => {
    expect((await resolveReadTarget("glob", { pattern: "*" }, process.cwd()))?.escapes).toBe(false);
    expect((await resolveReadTarget("grep", { pattern: "x" }, process.cwd()))?.escapes).toBe(false);
  });

  it("absolute and ../ traversal paths escape", async () => {
    expect(
      (await resolveReadTarget("read_file", { path: "/etc/hosts" }, process.cwd()))?.escapes,
    ).toBe(true);
    expect(
      (await resolveReadTarget("glob", { pattern: "*", cwd: "../../" }, process.cwd()))?.escapes,
    ).toBe(true);
  });

  it("glob pattern traversal escapes even with cwd unset", async () => {
    expect(
      (await resolveReadTarget("glob", { pattern: "../external/*" }, process.cwd()))?.escapes,
    ).toBe(true);
  });

  it("grep file_pattern traversal escapes", async () => {
    expect(
      (await resolveReadTarget("grep", { pattern: "X", file_pattern: "../ext/*" }, process.cwd()))
        ?.escapes,
    ).toBe(true);
  });

  it("grep filePattern (camelCase) traversal escapes", async () => {
    expect(
      (await resolveReadTarget("grep", { pattern: "X", filePattern: "../ext/*" }, process.cwd()))
        ?.escapes,
    ).toBe(true);
  });

  it("in-project glob pattern does not escape", async () => {
    expect((await resolveReadTarget("glob", { pattern: "src/**" }, process.cwd()))?.escapes).toBe(
      false,
    );
  });
});

describe("splitPatternPrefix", () => {
  it("splits a leading ../ traversal before the wildcard", () => {
    expect(splitPatternPrefix("../external/*")).toEqual({
      prefix: "../external",
      tailHasDotDot: false,
    });
  });

  it("splits a nested literal prefix before a ** wildcard", () => {
    expect(splitPatternPrefix("src/**/*.ts")).toEqual({ prefix: "src", tailHasDotDot: false });
  });

  it("flags a .. segment appearing after the first wildcard", () => {
    expect(splitPatternPrefix("*/../../x")).toEqual({ prefix: "", tailHasDotDot: true });
  });

  it("handles an absolute literal directory prefix", () => {
    const r = splitPatternPrefix("/abs/dir/*.ts");
    expect(r.prefix).toBe("/abs/dir");
    expect(r.tailHasDotDot).toBe(false);
  });

  it("treats a plain filename with no wildcard as a fully literal prefix", () => {
    expect(splitPatternPrefix("plain.txt")).toEqual({
      prefix: "plain.txt",
      tailHasDotDot: false,
    });
  });

  it("handles an empty pattern", () => {
    expect(splitPatternPrefix("")).toEqual({ prefix: "", tailHasDotDot: false });
  });
});
