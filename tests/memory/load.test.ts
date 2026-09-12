import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemories } from "../../src/memory/load";
import { MemoryStore } from "../../src/memory/store";

let dir: string;
let g: string;
let p: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-memload-"));
  g = join(dir, "global.md");
  p = join(dir, "project.md");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadMemories", () => {
  it("returns '' when both scopes are empty", () => {
    expect(loadMemories({ globalPath: g, projectPath: p })).toBe("");
  });

  it("formats both scopes under a Memories heading", () => {
    new MemoryStore(g).add("I use bun");
    new MemoryStore(p).add("deploys via fly");
    const out = loadMemories({ globalPath: g, projectPath: p });
    expect(out).toContain("## Memories");
    expect(out).toContain("Things to remember (global):");
    expect(out).toContain("- I use bun");
    expect(out).toContain("Things to remember (this project):");
    expect(out).toContain("- deploys via fly");
  });

  it("frames the block so the model recites it instead of reaching for a search tool", () => {
    new MemoryStore(p).add("deploys via fly");
    const out = loadMemories({ globalPath: g, projectPath: p });
    // Tells the model these facts are already here, not in any searchable index.
    expect(out).toContain("recite");
    expect(out).toContain("not stored in any searchable index");
  });

  it("omits an empty scope", () => {
    new MemoryStore(g).add("only global");
    const out = loadMemories({ globalPath: g, projectPath: p });
    expect(out).toContain("Things to remember (global):");
    expect(out).not.toContain("this project");
  });
});

function memFile(...bullets: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "mem-"));
  const path = join(dir, "memory.md");
  writeFileSync(path, bullets.map((b) => `- ${b}`).join("\n"));
  return path;
}

test("undefined projectPath → only the global tier", () => {
  const out = loadMemories({ globalPath: memFile("global fact") });
  expect(out).toContain("global fact");
  expect(out).toContain("Things to remember (global):");
  expect(out).not.toContain("this project");
});

test("undefined projectPath and empty global → empty string", () => {
  const out = loadMemories({ globalPath: join(tmpdir(), "does-not-exist-mem.md") });
  expect(out).toBe("");
});

test("both tiers present → both sub-sections", () => {
  const out = loadMemories({
    globalPath: memFile("global fact"),
    projectPath: memFile("project fact"),
  });
  expect(out).toContain("Things to remember (global):");
  expect(out).toContain("Things to remember (this project):");
  expect(out).toContain("project fact");
});
