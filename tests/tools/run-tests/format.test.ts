import { describe, expect, test } from "bun:test";
import { formatTestResult } from "../../../src/tools/run-tests/format";

const base = {
  stdout: "",
  stderr: "",
  timedOut: false,
  timeoutMs: 120_000,
  maxLines: 5,
  summaryRegex: undefined as RegExp | undefined,
};

describe("formatTestResult", () => {
  test("pass with summaryRegex appends the matched line, drops the rest", () => {
    const out = formatTestResult({
      ...base,
      exitCode: 0,
      stdout: "running 42 tests\nlots of noise\n=== 42 passed in 1.20s ===",
      summaryRegex: /^=+ .*(?:passed|failed|error).* =+$/m,
    });
    expect(out).toBe("✓ tests passed\n=== 42 passed in 1.20s ===");
  });

  test("pass without a summary match is just the headline", () => {
    const out = formatTestResult({ ...base, exitCode: 0, stdout: "all good\nno summary here" });
    expect(out).toBe("✓ tests passed");
  });

  test("fail shows the header and the output tail", () => {
    const out = formatTestResult({
      ...base,
      exitCode: 1,
      stdout: "test foo FAILED\nexpected 1 got 2",
    });
    expect(out).toBe("✗ tests failed (exit 1)\ntest foo FAILED\nexpected 1 got 2");
  });

  test("fail caps to the last maxLines with an omitted-count note", () => {
    const stdout = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n"); // 7 lines, cap 5
    const out = formatTestResult({ ...base, exitCode: 1, stdout, maxLines: 5 });
    expect(out).toBe("✗ tests failed (exit 1)\n…2 earlier lines omitted\nl3\nl4\nl5\nl6\nl7");
  });

  test("stdout and stderr are combined in order", () => {
    const out = formatTestResult({
      ...base,
      exitCode: 1,
      stdout: "out line",
      stderr: "err line",
    });
    expect(out).toBe("✗ tests failed (exit 1)\nout line\nerr line");
  });

  test("timeout uses the timeout header plus the tail", () => {
    const out = formatTestResult({
      ...base,
      exitCode: null,
      timedOut: true,
      timeoutMs: 3000,
      stdout: "hung here",
    });
    expect(out).toBe("✗ tests timed out after 3000ms\nhung here");
  });

  test("empty output on failure is the header alone", () => {
    const out = formatTestResult({ ...base, exitCode: 2 });
    expect(out).toBe("✗ tests failed (exit 2)");
  });

  test("null exit code on a plain failure renders 'unknown'", () => {
    const out = formatTestResult({ ...base, exitCode: null, stdout: "boom" });
    expect(out).toBe("✗ tests failed (exit unknown)\nboom");
  });

  test("trailing newline does not spuriously trigger the cap (ghost line)", () => {
    // exactly maxLines real lines, plus a trailing newline
    const stdout = `${["a", "b", "c", "d", "e"].join("\n")}\n`;
    const out = formatTestResult({ ...base, exitCode: 1, stdout, maxLines: 5 });
    expect(out).toBe("✗ tests failed (exit 1)\na\nb\nc\nd\ne");
  });

  test("trailing newline is trimmed on a passing summary-less run", () => {
    const out = formatTestResult({ ...base, exitCode: 1, stdout: "boom\n" });
    expect(out).toBe("✗ tests failed (exit 1)\nboom");
  });
});
