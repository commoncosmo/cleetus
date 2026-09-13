import { expect, test } from "bun:test";
import type { Row } from "../../../src/ui/tui/history-model";
import {
  formatTestResultStatus,
  isTestRun,
  latestFailedTestResult,
} from "../../../src/ui/tui/test-result";

function callFrom(row: Row): { name: string; args?: unknown } {
  return (row.event.payload as { call: { name: string; args?: unknown } }).call;
}

function result(id: string, ok: boolean, check?: "test" | "build" | "typecheck" | "lint"): Row {
  return {
    event: {
      id,
      sessionId: "s",
      ts: 1,
      type: "tool_call_start",
      payload: { call: { id, name: "run_tests", args: check ? { check } : {} } },
    },
    end: { ok, ...(ok ? {} : { errorMessage: "✗ tests failed (exit 1)\nstack trace" }) },
  };
}

test("test result statuses are compact and colorable", () => {
  const passed = result("pass", true);
  const failed = result("fail", false);
  expect(formatTestResultStatus(callFrom(passed), passed.end!)).toBe("✓ tests passed");
  expect(formatTestResultStatus(callFrom(failed), failed.end!)).toBe(
    "✗ tests failed · ctrl+e to show details",
  );
});

test("test result status names non-test checks", () => {
  const passed = result("build", true, "build");
  expect(formatTestResultStatus(callFrom(passed), passed.end!)).toBe("✓ build passed");
});

test("recognizes test commands run through Bash without matching a textual mention", () => {
  expect(
    isTestRun({ name: "bash", args: { command: "cd app && bun test src/router.test.ts" } }),
  ).toBe(true);
  expect(isTestRun({ name: "bash", args: { command: "uv run pytest tests" } })).toBe(true);
  expect(isTestRun({ name: "bash", args: { command: "rg 'bun test' src" } })).toBe(false);
});

test("latest failed test result ignores passed and ordinary tool rows", () => {
  const ordinary: Row = {
    event: {
      id: "bash",
      sessionId: "s",
      ts: 1,
      type: "tool_call_start",
      payload: { call: { id: "bash", name: "bash" } },
    },
    end: { ok: false, errorMessage: "ordinary tool failure" },
  };
  const oldFailure = result("old", false);
  const newestFailure = result("new", false);
  expect(
    latestFailedTestResult([ordinary, oldFailure, result("pass", true), newestFailure])?.event.id,
  ).toBe("new");
});
