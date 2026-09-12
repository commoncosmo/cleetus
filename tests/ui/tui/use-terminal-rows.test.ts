import { expect, test } from "bun:test";
import { normalizeRows } from "../../../src/ui/tui/use-terminal-rows";

test("returns a positive finite row count floored", () => {
  expect(normalizeRows(30, 24)).toBe(30);
  expect(normalizeRows(30.9, 24)).toBe(30);
});

test("falls back when rows is missing, zero, negative, or non-finite", () => {
  expect(normalizeRows(undefined, 24)).toBe(24);
  expect(normalizeRows(0, 24)).toBe(24);
  expect(normalizeRows(-5, 24)).toBe(24);
  expect(normalizeRows(Number.NaN, 24)).toBe(24);
  expect(normalizeRows(Number.POSITIVE_INFINITY, 24)).toBe(24);
});
