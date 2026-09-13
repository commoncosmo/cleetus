import type { Row, ToolEnd } from "./history-model";

/** Shortcut advertised beside failed test results. */
export const TEST_DETAILS_SHORTCUT = "ctrl+e";

interface ToolCall {
  name: string;
  args?: unknown;
}

function bashCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

/**
 * Test commands at a shell-command boundary. This recognizes the common built-in runners while
 * avoiding a mention such as `rg "bun test"` or `echo bun test`.
 */
const SHELL_TEST_COMMAND =
  /(?:^|&&|\|\||[;|\n])\s*(?:(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:bun\s+test\b|bun\s+run\s+test\b|bunx\s+(?:vitest|jest)\b|(?:uv\s+run\s+)?pytest\b|python(?:3)?\s+-m\s+pytest\b|cargo\s+test\b|go\s+test\b|swift\s+test\b|(?:npm|pnpm|yarn)\s+test\b|make\s+test\b)/;

/** True when a tool call was made through a test runner, directly or through Bash. */
export function isTestRun(call: ToolCall): boolean {
  return (
    call.name === "run_tests" ||
    (call.name === "bash" && SHELL_TEST_COMMAND.test(bashCommand(call.args) ?? ""))
  );
}

function checkLabel(args: unknown): string {
  if (!args || typeof args !== "object") return "tests";
  const check = (args as { check?: unknown }).check;
  if (check === "build" || check === "typecheck" || check === "lint") return check;
  return "tests";
}

/** One compact, colorable status line for a completed test/check run. */
export function formatTestResultStatus(call: ToolCall, end: ToolEnd): string {
  const label = checkLabel(call.args);
  return end.ok
    ? `✓ ${label} passed`
    : `✗ ${label} failed · ${TEST_DETAILS_SHORTCUT} to show details`;
}

/** Most recent failed test/check result in transcript order, or null when all passed. */
export function latestFailedTestResult(rows: readonly Row[]): Row | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.event.type !== "tool_call_start" || row.end?.ok !== false) continue;
    const call = row.event.payload as { call: ToolCall };
    if (isTestRun(call.call)) return row;
  }
  return null;
}
