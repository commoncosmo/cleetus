import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCAFFOLD_EXCLUDES,
  ensureScaffoldExcludes,
  mergeExcludes,
} from "../../../src/tools/git/excludes";
import { scriptedSandbox } from "../../git/helpers";

describe("SCAFFOLD_EXCLUDES", () => {
  test("covers the hygiene set from the issue", () => {
    expect(SCAFFOLD_EXCLUDES).toEqual([
      "node_modules/",
      "dist/",
      "build/",
      ".cleetus/",
      "*.log",
      ".env",
    ]);
  });
});

describe("mergeExcludes", () => {
  test("empty existing → appends all entries under a cleetus marker", () => {
    const r = mergeExcludes("", SCAFFOLD_EXCLUDES);
    expect(r).not.toBeNull();
    expect(r!.added).toEqual(SCAFFOLD_EXCLUDES);
    expect(r!.content).toContain("# cleetus:");
    expect(r!.content).toContain("node_modules/");
    expect(r!.content.endsWith("\n")).toBe(true);
  });

  test("all entries already present → null (idempotent)", () => {
    const existing = `${SCAFFOLD_EXCLUDES.join("\n")}\n`;
    expect(mergeExcludes(existing, SCAFFOLD_EXCLUDES)).toBeNull();
  });

  test("partial → only the missing entries are added, existing preserved", () => {
    const existing = "node_modules/\n.env\n";
    const r = mergeExcludes(existing, SCAFFOLD_EXCLUDES);
    expect(r).not.toBeNull();
    expect(r!.added).toEqual(["dist/", "build/", ".cleetus/", "*.log"]);
    expect(r!.content.startsWith("node_modules/\n.env\n")).toBe(true);
    expect(r!.content).not.toContain("node_modules/\nnode_modules/");
  });

  test("existing without a trailing newline → a separator newline is inserted", () => {
    const r = mergeExcludes("foo/bar", ["dist/"]);
    expect(r!.content.startsWith("foo/bar\n")).toBe(true);
    expect(r!.content).toContain("dist/");
  });

  test("comparison is line-trimmed (whitespace-padded existing entry counts as present)", () => {
    const r = mergeExcludes("  node_modules/  \n", ["node_modules/"]);
    expect(r).toBeNull();
  });
});

describe("ensureScaffoldExcludes", () => {
  test("node_modules already ignored (check-ignore exit 0) → no-op, no write", async () => {
    const { sandbox, calls } = scriptedSandbox([
      { match: "check-ignore", result: { exitCode: 0 } },
    ]);
    const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };
    expect(await ensureScaffoldExcludes(sandbox, ctx)).toBe("");
    // bailed after the probe — no path resolution
    expect(calls.some((c) => c.command.includes("rev-parse"))).toBe(false);
    expect(calls[0]!.command).toBe("git check-ignore -q node_modules/");
  });

  test("not a git repo (check-ignore exit 128) → no-op", async () => {
    const { sandbox } = scriptedSandbox([{ match: "check-ignore", result: { exitCode: 128 } }]);
    const ctx = { projectDir: "/proj", abortSignal: new AbortController().signal };
    expect(await ensureScaffoldExcludes(sandbox, ctx)).toBe("");
  });

  test("not ignored (exit 1) → seeds info/exclude and returns the note; idempotent on re-run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-excl-"));
    await mkdir(join(dir, ".git", "info"), { recursive: true });
    const { sandbox } = scriptedSandbox([
      { match: "check-ignore", result: { exitCode: 1 } },
      { match: "rev-parse", result: { exitCode: 0, stdout: ".git/info/exclude\n" } },
    ]);
    const ctx = { projectDir: dir, abortSignal: new AbortController().signal };

    const note = await ensureScaffoldExcludes(sandbox, ctx);
    expect(note).toContain("seeded .git/info/exclude");
    expect(note).toContain("node_modules/");
    const written = await Bun.file(join(dir, ".git", "info", "exclude")).text();
    expect(written).toContain("node_modules/");
    expect(written).toContain(".cleetus/");

    // second run sees the now-seeded file → nothing to add → ""
    expect(await ensureScaffoldExcludes(sandbox, ctx)).toBe("");

    await rm(dir, { recursive: true, force: true });
  });
});
