import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeAcpInstructions } from "../../src/acp/instructions";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "acp-cfg-"));
}

test("loads instructions.md from the config dir", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "instructions.md"), "Use Bun.");
  const proj = tmp();
  expect(await composeAcpInstructions({ globalDir: dir, projectDir: proj })).toBe("Use Bun.");
});

test("composes the --instructions flag file after the native source", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "instructions.md"), "Native.");
  const proj = tmp();
  const flag = join(tmp(), "flag.md");
  writeFileSync(flag, "Flag.");
  expect(
    await composeAcpInstructions({ globalDir: dir, projectDir: proj, instructionsFlag: flag }),
  ).toBe("Native.\n\nFlag.");
});

test("empty everywhere → empty string (back-compat)", async () => {
  const dir = tmp();
  const proj = tmp();
  expect(await composeAcpInstructions({ globalDir: dir, projectDir: proj })).toBe("");
});

test("folds the project-home instructions between global and cwd", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "acp-cfg-"));
  writeFileSync(join(globalDir, "instructions.md"), "GLOBAL");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".cleetus"), { recursive: true });
  writeFileSync(join(home, ".cleetus", "instructions.md"), "HOME");
  const proj = mkdtempSync(join(tmpdir(), "cwd-"));

  const out = await composeAcpInstructions({ globalDir, projectDir: proj, projectHome: home });
  expect(out).toContain("GLOBAL");
  expect(out).toContain("HOME");
  expect(out.indexOf("GLOBAL")).toBeLessThan(out.indexOf("HOME"));
});

test("includeProjectInstructions=false skips every project instruction source", async () => {
  const globalDir = mkdtempSync(join(tmpdir(), "acp-cfg-"));
  writeFileSync(join(globalDir, "instructions.md"), "GLOBAL");
  const home = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(home, ".cleetus"), { recursive: true });
  writeFileSync(join(home, ".cleetus", "instructions.md"), "HOME");
  const proj = mkdtempSync(join(tmpdir(), "cwd-"));
  mkdirSync(join(proj, ".cleetus"), { recursive: true });
  writeFileSync(join(proj, ".cleetus", "instructions.md"), "CWD");
  writeFileSync(join(proj, "CLEETUS.md"), "CLEETUS");

  const out = await composeAcpInstructions({
    globalDir,
    projectDir: proj,
    projectHome: home,
    includeProjectInstructions: false,
  });
  expect(out).toContain("GLOBAL");
  expect(out).not.toContain("HOME");
  expect(out).not.toContain("CWD");
  expect(out).not.toContain("CLEETUS");
});
