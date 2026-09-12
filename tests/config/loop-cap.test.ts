import { expect, it, test } from "bun:test";
import {
  DEFAULT_MAX_TOOL_LOOPS,
  capCheckpointNote,
  resolveMaxToolLoops,
} from "../../src/config/loop-cap";

test("tool loops are unlimited by default", () => {
  expect(DEFAULT_MAX_TOOL_LOOPS).toBe(0);
  expect(resolveMaxToolLoops(undefined, DEFAULT_MAX_TOOL_LOOPS).value).toBe(
    Number.POSITIVE_INFINITY,
  );
});

test("a valid --max-loops flag overrides the resolved config value", () => {
  expect(resolveMaxToolLoops("250", DEFAULT_MAX_TOOL_LOOPS)).toEqual({ value: 250 });
});

test("an invalid --max-loops flag falls back to the config value with a warning", () => {
  const r = resolveMaxToolLoops("nope", 100);
  expect(r.value).toBe(100);
  expect(r.warning).toContain("invalid --max-loops");
});

test("no flag yields the config value unchanged", () => {
  expect(resolveMaxToolLoops(undefined, 100)).toEqual({ value: 100 });
});

test("a negative flag is rejected and falls back with a warning", () => {
  const r = resolveMaxToolLoops("-5", 100);
  expect(r.value).toBe(100);
  expect(r.warning).toMatch(/invalid --max-loops/);
});

test("a non-integer flag is rejected and falls back", () => {
  expect(resolveMaxToolLoops("3.5", 100).value).toBe(100);
});

test("a non-numeric flag is rejected and falls back", () => {
  expect(resolveMaxToolLoops("abc", 100).value).toBe(100);
});

it("0 flag or 0 config resolves to unlimited (Infinity)", () => {
  expect(resolveMaxToolLoops("0", 100).value).toBe(Number.POSITIVE_INFINITY);
  expect(resolveMaxToolLoops(undefined, 0).value).toBe(Number.POSITIVE_INFINITY);
});
it("a positive flag still wins; negative flag warns and falls back", () => {
  expect(resolveMaxToolLoops("250", 100).value).toBe(250);
  const r = resolveMaxToolLoops("-1", 100);
  expect(r.value).toBe(100);
  expect(r.warning).toBeDefined();
});
it("capCheckpointNote mentions the step count and how to lift the cap", () => {
  const note = capCheckpointNote(100);
  expect(note).toContain("100");
  expect(note).toContain("continue");
  expect(note).toContain("/maxloops");
  expect(note).toContain("incomplete");
});
