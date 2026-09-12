import { expect, test } from "bun:test";
import { formatSmokeResult } from "../../../src/tools/smoke-run/format";

const base = {
  command: "bun run build",
  seconds: 10,
  exitCode: 0 as number | null,
  stdout: "",
  stderr: "",
  timedOut: false,
  maxLines: 100,
};

test("clean exit → ✓ and echoes the command", () => {
  const out = formatSmokeResult({ ...base, exitCode: 0, stdout: "done" });
  expect(out).toContain("✓ exited cleanly (code 0)");
  expect(out).toContain("$ bun run build");
  expect(out).toContain("done");
});

test("non-zero exit → ✗ with the code (not framed as success)", () => {
  const out = formatSmokeResult({ ...base, exitCode: 1, stderr: "boom" });
  expect(out).toContain("✗ exited with code 1");
  expect(out).toContain("boom");
});

test("still running (timed out), no hang signal → ⏱ with a read-the-output nudge", () => {
  const out = formatSmokeResult({
    ...base,
    command: "bun run dev",
    timedOut: true,
    exitCode: null,
    stdout: "VITE v6 ready in 312 ms\n➜ Local: http://localhost:1420/",
  });
  expect(out).toContain("⏱ still running after 10s");
  expect(out.toLowerCase()).toContain("read the output");
  expect(out).toContain("VITE v6 ready");
});

test("timed out WITH a hang signal → ⚠ likely stuck + remediation hint", () => {
  const out = formatSmokeResult({
    ...base,
    command: "bun run tauri dev",
    timedOut: true,
    exitCode: null,
    stdout: "Warn Waiting for your frontend dev server to start on http://localhost:1420/..",
  });
  expect(out).toContain("⚠ likely stuck after 10s");
  expect(out).toContain("beforeDevCommand");
  expect(out).toContain("Waiting for your frontend dev server"); // raw output still shown
  expect(out).not.toContain("⏱ still running"); // not the plain note
});

test("empty output → just the verdict + command, no trailing body", () => {
  const out = formatSmokeResult({ ...base, exitCode: 0, stdout: "", stderr: "" });
  expect(out).toBe("✓ exited cleanly (code 0)\n$ bun run build");
});

test("output longer than maxLines is capped head+tail with an omitted marker", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
  const out = formatSmokeResult({ ...base, exitCode: 0, stdout: lines, maxLines: 10 });
  expect(out).toContain("line0"); // head kept
  expect(out).toContain("line49"); // tail kept
  expect(out).toContain("lines omitted");
  expect(out).not.toContain("line25"); // middle dropped
});

test("survivors → appends a teardown warning naming the pids", () => {
  const out = formatSmokeResult({
    ...base,
    command: "bun run dev",
    timedOut: true,
    exitCode: null,
    stdout: "VITE ready",
    survivors: [4821, 4830],
  });
  expect(out).toContain("⏱ still running after 10s");
  expect(out).toContain("⚠ 2 process(es) survived teardown");
  expect(out).toContain("4821, 4830");
});

test("no survivors → no teardown warning", () => {
  const out = formatSmokeResult({ ...base, exitCode: 0, stdout: "done" });
  expect(out).not.toContain("survived teardown");
});
