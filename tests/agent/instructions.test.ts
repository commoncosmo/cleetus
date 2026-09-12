import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emphasizeInstructions,
  instructionSourcePaths,
  loadInstructions,
} from "../../src/agent/instructions";

describe("emphasizeInstructions", () => {
  it("prefixes a non-empty instructions string with the lead", () => {
    expect(emphasizeInstructions("prefer Bun", "LEAD:")).toBe("LEAD:\nprefer Bun");
  });
  it("trims the body", () => {
    expect(emphasizeInstructions("  prefer Bun  ", "LEAD:")).toBe("LEAD:\nprefer Bun");
  });
  it("returns empty string for blank/whitespace instructions", () => {
    expect(emphasizeInstructions("   ", "LEAD:")).toBe("");
    expect(emphasizeInstructions("", "LEAD:")).toBe("");
  });
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cleetus-instr-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadInstructions", () => {
  it("concatenates global, project .cleetus/instructions.md, and CLEETUS.md", async () => {
    const global = join(root, "global.md");
    await writeFile(global, "GLOBAL_RULES");
    const proj = join(root, "proj");
    await mkdir(join(proj, ".cleetus"), { recursive: true });
    await writeFile(join(proj, ".cleetus", "instructions.md"), "PROJECT_RULES");
    await writeFile(join(proj, "CLEETUS.md"), "CLEETUS_RULES");
    const text = await loadInstructions({ globalPath: global, startDir: proj });
    expect(text).toContain("GLOBAL_RULES");
    expect(text).toContain("PROJECT_RULES");
    expect(text).toContain("CLEETUS_RULES");
  });

  it("walks up parents and finds nearest CLEETUS.md", async () => {
    await writeFile(join(root, "CLEETUS.md"), "TOP");
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    const text = await loadInstructions({ globalPath: join(root, "missing.md"), startDir: nested });
    expect(text).toContain("TOP");
  });

  it("returns empty string when nothing found", async () => {
    const text = await loadInstructions({ globalPath: join(root, "x.md"), startDir: root });
    expect(text).toBe("");
  });
});

function seedInstr(dir: string, body: string): void {
  mkdirSync(join(dir, ".cleetus"), { recursive: true });
  writeFileSync(join(dir, ".cleetus", "instructions.md"), body);
}

test("project-home tier sits between global and the cwd walk", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "g-"));
  writeFileSync(join(globalDir, "instructions.md"), "GLOBAL");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  seedInstr(home, "HOME");
  const cwd = mkdtempSync(join(tmpdir(), "cwd-")); // foreign tree, its own instructions
  seedInstr(cwd, "CWD");

  const out = await loadInstructions({
    globalPath: join(globalDir, "instructions.md"),
    startDir: cwd,
    projectHome: home,
  });
  expect(out.indexOf("GLOBAL")).toBeLessThan(out.indexOf("HOME"));
  expect(out.indexOf("HOME")).toBeLessThan(out.indexOf("CWD"));
});

test("cwd under the home → project-home instructions appear exactly once", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  seedInstr(home, "HOMEONLY");
  const sub = join(home, "packages", "app");
  mkdirSync(sub, { recursive: true });

  const out = await loadInstructions({
    globalPath: join(mkdtempSync(join(tmpdir(), "g-")), "instructions.md"), // absent global
    startDir: sub,
    projectHome: home,
  });
  expect(out.match(/HOMEONLY/g)?.length ?? 0).toBe(1);
});

test("includeProjectInstructions=false drops home, cwd, and CLEETUS.md project sources", async () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  seedInstr(home, "HOME");
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  seedInstr(cwd, "CWD");
  writeFileSync(join(cwd, "CLEETUS.md"), "CLEETUS");
  const globalDir = mkdtempSync(join(tmpdir(), "g-"));
  writeFileSync(join(globalDir, "instructions.md"), "GLOBAL");

  const out = await loadInstructions({
    globalPath: join(globalDir, "instructions.md"),
    startDir: cwd,
    projectHome: home,
    includeProjectInstructions: false,
  });
  expect(out).toContain("GLOBAL");
  expect(out).not.toContain("HOME");
  expect(out).not.toContain("CWD");
  expect(out).not.toContain("CLEETUS");
});

test("no projectHome → unchanged (global + cwd walk only)", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "g-"));
  writeFileSync(join(globalDir, "instructions.md"), "GLOBAL");
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  seedInstr(cwd, "CWD");

  const out = await loadInstructions({
    globalPath: join(globalDir, "instructions.md"),
    startDir: cwd,
  });
  expect(out).toBe("GLOBAL\n\nCWD");
});

test("instructionSourcePaths exposes the effective source order without duplicates", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "g-"));
  const globalPath = join(globalDir, "instructions.md");
  writeFileSync(globalPath, "GLOBAL");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const homePath = join(home, ".cleetus", "instructions.md");
  seedInstr(home, "HOME");
  writeFileSync(join(home, "CLEETUS.md"), "CLEETUS");
  const sub = join(home, "packages", "app");
  mkdirSync(sub, { recursive: true });

  expect(
    await instructionSourcePaths({
      globalPath,
      startDir: sub,
      projectHome: home,
    }),
  ).toEqual([globalPath, homePath, join(home, "CLEETUS.md")]);
});
