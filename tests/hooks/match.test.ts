import { expect, test } from "bun:test";
import { matchHooks } from "../../src/hooks/match";
import type { HookEntry } from "../../src/hooks/types";

const ENTRIES: HookEntry[] = [
  { event: "pre_tool_use", matcher: "bash", command: "a" },
  { event: "pre_tool_use", command: "b" }, // no matcher = all
  { event: "post_tool_use", matcher: "write_file|edit_file", command: "c" },
  { event: "pre_tool_use", matcher: "qwen[", command: "bad-regex" }, // invalid → never matches
];

test("matches by event + regex, preserving order", () => {
  const m = matchHooks(ENTRIES, "pre_tool_use", "bash");
  expect(m.map((h) => h.command)).toEqual(["a", "b"]); // bash hook + the all-hook, in order
});

test("omitted matcher matches every tool", () => {
  expect(matchHooks(ENTRIES, "pre_tool_use", "read_file").map((h) => h.command)).toEqual(["b"]);
});

test("event filters", () => {
  expect(matchHooks(ENTRIES, "post_tool_use", "write_file").map((h) => h.command)).toEqual(["c"]);
});

test("invalid matcher regex never matches (defensive)", () => {
  expect(matchHooks(ENTRIES, "pre_tool_use", "qwen[").some((h) => h.command === "bad-regex")).toBe(
    false,
  );
});
