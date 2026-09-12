import { describe, expect, test } from "bun:test";
import { TestObjectSchema } from "../../src/config/schema";
import {
  DEFAULT_TEST_MAX_OUTPUT_LINES,
  DEFAULT_TEST_TIMEOUT_MS,
  resolveTest,
} from "../../src/config/test";

describe("resolveTest", () => {
  test("defaults: enabled, no command, default timeout and cap", () => {
    expect(resolveTest()).toEqual({
      enabled: true,
      command: undefined,
      timeoutMs: DEFAULT_TEST_TIMEOUT_MS,
      maxOutputLines: DEFAULT_TEST_MAX_OUTPUT_LINES,
    });
  });

  test("project overrides global for every field", () => {
    const global = {
      enabled: true,
      command: "make test",
      timeout_ms: 1000,
      max_output_lines: 10,
    };
    const project = {
      enabled: false,
      command: ["bun", "test"],
      timeout_ms: 2000,
      max_output_lines: 20,
    };
    expect(resolveTest(global, project)).toEqual({
      enabled: false,
      command: ["bun", "test"],
      timeoutMs: 2000,
      maxOutputLines: 20,
    });
  });

  test("global applies when project omits a field", () => {
    expect(resolveTest({ command: "pytest" }, {})).toEqual({
      enabled: true,
      command: "pytest",
      timeoutMs: DEFAULT_TEST_TIMEOUT_MS,
      maxOutputLines: DEFAULT_TEST_MAX_OUTPUT_LINES,
    });
  });

  test("enabled:false is respected (not swallowed by ??)", () => {
    expect(resolveTest({}, { enabled: false }).enabled).toBe(false);
  });
});

describe("TestObjectSchema.command", () => {
  test("accepts a non-empty string and a non-empty array", () => {
    expect(TestObjectSchema.parse({ command: "bun test" }).command).toBe("bun test");
    expect(TestObjectSchema.parse({ command: ["bun", "test"] }).command).toEqual(["bun", "test"]);
  });

  test("rejects an empty array", () => {
    expect(TestObjectSchema.safeParse({ command: [] }).success).toBe(false);
  });

  test("rejects an empty string", () => {
    expect(TestObjectSchema.safeParse({ command: "" }).success).toBe(false);
  });
});
