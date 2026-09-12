import { expect, test } from "bun:test";
import { MAIN_INSTR_LEAD, composeInstructions } from "../../src/agent/instructions";

test("composeInstructions joins non-empty sources in order with a blank line", () => {
  expect(composeInstructions(["base rule", "project rule"])).toBe("base rule\n\nproject rule");
});

test("composeInstructions trims each source and drops empties", () => {
  expect(composeInstructions(["  base  ", "", "   "])).toBe("base");
  expect(composeInstructions([])).toBe("");
});

test("MAIN_INSTR_LEAD is a non-empty standing-preferences lead", () => {
  expect(MAIN_INSTR_LEAD.toLowerCase()).toContain("standing preferences");
});
