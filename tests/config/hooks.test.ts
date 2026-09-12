import { expect, test } from "bun:test";
import { resolveHooks } from "../../src/config/hooks";
import { HookEntrySchema } from "../../src/config/schema";

test("empty when nothing configured", () => {
  expect(resolveHooks(undefined, undefined)).toEqual([]);
});

test("global then project, snake_case timeout mapped to camelCase", () => {
  const got = resolveHooks(
    [{ event: "pre_tool_use", command: "g", timeout_ms: 5000 }],
    [{ event: "post_tool_use", matcher: "bash", command: "p" }],
  );
  expect(got).toEqual([
    { event: "pre_tool_use", matcher: undefined, command: "g", timeoutMs: 5000 },
    { event: "post_tool_use", matcher: "bash", command: "p", timeoutMs: undefined },
  ]);
});

test("an invalid matcher regex is rejected at schema validation", () => {
  expect(() =>
    HookEntrySchema.parse({ event: "pre_tool_use", command: "x", matcher: "[invalid" }),
  ).toThrow(/invalid hook matcher regex/);
});

test("a valid entry passes schema validation", () => {
  expect(() =>
    HookEntrySchema.parse({ event: "post_tool_use", command: "ok", matcher: "bash|write_file" }),
  ).not.toThrow();
});
