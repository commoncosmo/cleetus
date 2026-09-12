import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAcpPromptScope } from "../../src/acp/prompt-scope";

function scopeDir(): { globalDir: string; home: string; cwd: string } {
  const globalDir = mkdtempSync(join(tmpdir(), "g-"));
  writeFileSync(join(globalDir, "instructions.md"), "GLOBAL_INSTR");
  writeFileSync(join(globalDir, "memory.md"), "- global fact");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".cleetus"), { recursive: true });
  writeFileSync(join(home, ".cleetus", "instructions.md"), "HOME_INSTR");
  writeFileSync(join(home, ".cleetus", "memory.md"), "- project fact");
  const cwd = mkdtempSync(join(tmpdir(), "cwd-"));
  return { globalDir, home, cwd };
}

test("full project scope: instructions + memory + artifact all present", async () => {
  const { globalDir, home, cwd } = scopeDir();
  const s = await buildAcpPromptScope({ globalDir, projectDir: cwd, projectHome: home });
  expect(s.instructions).toContain("GLOBAL_INSTR");
  expect(s.instructions).toContain("HOME_INSTR");
  expect(s.memories).toContain("global fact");
  expect(s.memories).toContain("project fact");
  expect(s.artifact).toContain(join(home, "artifacts"));
});

test("inheritProjectMemory=false drops project memory only (global + instructions stay)", async () => {
  const { globalDir, home, cwd } = scopeDir();
  const s = await buildAcpPromptScope({
    globalDir,
    projectDir: cwd,
    projectHome: home,
    inheritProjectMemory: false,
  });
  expect(s.memories).toContain("global fact");
  expect(s.memories).not.toContain("project fact");
  expect(s.instructions).toContain("HOME_INSTR");
});

test("inheritProjectInstructions=false drops project instructions only (memory stays)", async () => {
  const { globalDir, home, cwd } = scopeDir();
  const s = await buildAcpPromptScope({
    globalDir,
    projectDir: cwd,
    projectHome: home,
    inheritProjectInstructions: false,
  });
  expect(s.instructions).not.toContain("HOME_INSTR");
  expect(s.instructions).toContain("GLOBAL_INSTR");
  expect(s.memories).toContain("project fact");
});

test("no projectHome → cwd project memory and no artifact (loose conversation)", async () => {
  const { globalDir, cwd } = scopeDir();
  mkdirSync(join(cwd, ".cleetus"), { recursive: true });
  writeFileSync(join(cwd, ".cleetus", "memory.md"), "- cwd fact");
  const s = await buildAcpPromptScope({ globalDir, projectDir: cwd });
  expect(s.memories).toContain("global fact");
  expect(s.memories).toContain("cwd fact");
  expect(s.memories).not.toContain("project fact");
  expect(s.artifact).toBe("");
  expect(s.instructions).toContain("GLOBAL_INSTR");
  expect(s.instructions).not.toContain("HOME_INSTR");
});
