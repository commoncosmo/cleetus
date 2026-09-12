import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAcpInstructions } from "../../src/acp/instructions";

test("returns composed file text when the path is readable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-instr-"));
  const p = join(dir, "instructions.md");
  writeFileSync(p, "  Use Bun, never npm.  \n");
  expect(await loadAcpInstructions(p)).toBe("Use Bun, never npm.");
});

test("returns empty string when path is absent or missing", async () => {
  expect(await loadAcpInstructions(undefined)).toBe("");
  expect(await loadAcpInstructions("/no/such/file.md")).toBe("");
});
