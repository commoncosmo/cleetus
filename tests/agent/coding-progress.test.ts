import { expect, test } from "bun:test";
import { join } from "node:path";
import { CodingProgressGuard, isResearchInspection } from "../../src/agent/coding-progress";
import { retrievalToolMadeProgress } from "../../src/agent/retrieval-efficiency";
import type { ToolResult } from "../../src/tools/types";

const fetchCall = { name: "web_fetch", args: { url: "https://example.com/llms.txt" } };
const page = (startLine: number, endLine: number, matched = true): ToolResult => ({
  ok: true,
  output: "reference",
  documentation: {
    url: "https://example.com/llms.txt",
    matched,
    cached: true,
    startLine,
    endLine,
    totalLines: 1283,
  },
});

test("ct4 mixed PowerShell/document research gets a checkpoint before dozens of calls", () => {
  const guard = new CodingProgressGuard("/project", true);
  guard.observe({ name: "scaffold", args: {} }, { ok: true });
  let reminder = "";
  for (let i = 0; i < 10; i++) {
    const call =
      i % 2
        ? { name: "bash", args: { command: "Get-Content package.json | Out-String -Width 200" } }
        : fetchCall;
    reminder =
      guard.observe(call, i % 2 ? { ok: true, output: "{}" } : page(i * 10 + 1, i * 10 + 10))
        .reminder ?? reminder;
  }
  expect(reminder).toContain("10 inspection calls");
  expect(reminder).toContain("Confirmed writes this turn: none");
  expect(reminder).toContain("passing template builds are not evidence");
});

test("different queries and overlapping ranges cannot disguise repeated documentation", () => {
  const guard = new CodingProgressGuard("/project", true);
  expect(guard.observe(fetchCall, page(1, 200)).madeProgress).toBe(true);
  for (const [start, end] of [
    [33, 92],
    [43, 112],
  ])
    expect(guard.observe(fetchCall, page(start!, end!)).madeProgress).toBe(false);
  const repeated = guard.observe({ ...fetchCall, args: { query: "mount(" } }, page(47, 96));
  expect(repeated.madeProgress).toBe(false);
  expect(repeated.reminder).toContain("already-covered");
  const newPage = guard.observe(fetchCall, page(190, 230));
  expect(newPage.madeProgress).toBe(true);
  expect(newPage.reminder).toBeUndefined();
});

test("no-match documentation is unproductive even in a coding task", () => {
  const result = page(1, 1, false);
  expect(retrievalToolMadeProgress(null, "web_fetch", result)).toBe(false);
  const guard = new CodingProgressGuard("/project", true);
  for (let i = 0; i < 2; i++) expect(guard.observe(fetchCall, result).reminder).toBeUndefined();
  expect(guard.observe(fetchCall, result).reminder).toContain("3 empty");
});

test("only successful tool writes count as confirmed implementation and reset research", () => {
  const guard = new CodingProgressGuard("/project", true);
  guard.observe(
    { name: "write_file", args: { path: "src/App.tsrx" } },
    { ok: false, errorMessage: "failed" },
  );
  expect(guard.snapshot()).toContain("writes this turn: none");
  for (let i = 0; i < 9; i++)
    guard.observe({ name: "read_file", args: { path: "package.json" } }, { ok: true });
  guard.observe(
    { name: "write_file", args: {} },
    {
      ok: true,
      diff: {
        path: join("/project", "src", "App.tsrx"),
        before: "",
        after: "export function App() @{}",
        created: true,
      },
    },
  );
  expect(guard.snapshot()).toContain("App.tsrx");
  expect(guard.snapshot()).toContain("reverify");
  expect(guard.observe(fetchCall, page(1, 20)).reminder).toBeUndefined();
});

test("a passing vanilla template build does not invent framework integration writes", () => {
  const guard = new CodingProgressGuard("/project", true);
  guard.observe({ name: "scaffold", args: {} }, { ok: true });
  guard.observe(
    { name: "run_tests", args: { check: "build" } },
    { ok: true, output: "build passed" },
  );
  expect(guard.snapshot()).toContain("Confirmed writes this turn: none");
  expect(guard.snapshot()).toContain("connect the requested framework");
});

test("inspection recognition is advisory and excludes source mutation commands", () => {
  expect(
    isResearchInspection({
      name: "bash",
      args: { command: "Select-String -Path docs.txt -Pattern 'tsconfig' | Out-String -Width 200" },
    }),
  ).toBe(true);
  expect(
    isResearchInspection({
      name: "bash",
      args: { command: "Get-Content x; Set-Content y 'changed'" },
    }),
  ).toBe(false);
});
