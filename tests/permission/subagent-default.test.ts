import { describe, expect, test } from "bun:test";
import { BUILTIN_DEFAULTS } from "../../src/permission/types";

describe("BUILTIN_DEFAULTS", () => {
  test("the task (subagent) tool defaults to ask", () => {
    expect(BUILTIN_DEFAULTS.task).toBe("ask");
  });

  test("the smoke_run tool defaults to ask", () => {
    expect(BUILTIN_DEFAULTS.smoke_run).toBe("ask");
  });
});
