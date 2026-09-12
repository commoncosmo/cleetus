import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyWinner, composePrompt, diffLines, proposeWinner } from "../../src/improve/promote";

test("composePrompt joins non-empty parts with blank lines", () => {
  expect(composePrompt("G", "I", "M")).toBe("G\n\nI\n\nM");
  expect(composePrompt("", "I", "")).toBe("I");
  expect(composePrompt("", "", "")).toBe("");
});

test("diffLines shows removed and added lines", () => {
  const d = diffLines("a\nb", "a\nc");
  expect(d).toContain("- b");
  expect(d).toContain("+ c");
});

test("proposeWinner writes candidates/<name>.yaml and returns a diff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-promote-"));
  const variant = { name: "mut-1", instructions: "Be careful.", systemPrompt: "G\n\nBe careful." };
  const { candidatePath, diff } = await proposeWinner(variant, {
    projectDir: dir,
    baseInstructions: "Be quick.",
    now: 1,
  });
  expect(candidatePath).toBe(join(dir, "candidates", "mut-1.yaml"));
  const yaml = readFileSync(candidatePath, "utf8");
  expect(yaml).toContain("system_prompt");
  expect(yaml).toContain("Be careful.");
  expect(diff).toContain("Be careful.");
});

test("applyWinner backs up existing instructions then writes the new block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-apply-"));
  mkdirSync(join(dir, ".cleetus"), { recursive: true });
  writeFileSync(join(dir, ".cleetus", "instructions.md"), "OLD");
  const variant = { name: "mut-1", instructions: "NEW", systemPrompt: "G\n\nNEW" };
  const { backupPath, instructionsPath } = await applyWinner(variant, {
    projectDir: dir,
    baseInstructions: "OLD",
    now: 42,
  });
  expect(instructionsPath).toBe(join(dir, ".cleetus", "instructions.md"));
  expect(readFileSync(instructionsPath, "utf8")).toBe("NEW");
  expect(backupPath).toBe(join(dir, ".cleetus", "instructions.md.bak-42"));
  expect(readFileSync(backupPath!, "utf8")).toBe("OLD");
});

test("applyWinner with no existing instructions writes without a backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cleetus-apply2-"));
  const variant = { name: "mut-1", instructions: "NEW", systemPrompt: "NEW" };
  const { backupPath, instructionsPath } = await applyWinner(variant, {
    projectDir: dir,
    baseInstructions: "",
    now: 7,
  });
  expect(backupPath).toBeNull();
  expect(readFileSync(instructionsPath, "utf8")).toBe("NEW");
  expect(existsSync(join(dir, ".cleetus", "instructions.md.bak-7"))).toBe(false);
});
