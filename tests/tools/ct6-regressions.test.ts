import { expect, test } from "bun:test";
import type { ExecOptions, Sandbox } from "../../src/sandbox/types";
import { BashTool } from "../../src/tools/bash";
import { classifyControlAttempt } from "../../src/tools/render-check/tool";

const ctx = { projectDir: process.cwd(), abortSignal: new AbortController().signal };
function fixture(timedOut = false) {
  const calls: ExecOptions[] = [];
  const sandbox: Sandbox = {
    async exec(_command, options) {
      calls.push(options);
      return { stdout: "", stderr: "", exitCode: timedOut ? null : 0, timedOut, cancelled: false };
    },
    async dispose() {},
    writeRoot: () => null,
  };
  return { tool: new BashTool(sandbox, { enforcePackageManager: false }), calls };
}
test("ct6 seconds-like and invalid timeouts are rejected before launching", async () => {
  const { tool, calls } = fixture();
  for (const timeoutMs of [30, 60, 120, 0, -1, 999, Number.NaN, Number.POSITIVE_INFINITY, 1000.5]) {
    const result = await tool.run({ command: "Get-Date", timeoutMs }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toContain("milliseconds");
    expect(result.errorMessage).toContain("30000");
  }
  expect(calls).toHaveLength(0);
  expect((await tool.run({ command: "Get-Date", timeoutMs: 30000 }, ctx)).ok).toBe(true);
  expect(calls[0]!.timeoutMs).toBe(30000);
  await tool.run({ command: "Get-Date" }, ctx);
  expect(calls[1]!.timeoutMs).toBe(120000);
});
test("ordinary timeouts give unit guidance; server timeouts give lifecycle guidance", async () => {
  const { tool } = fixture(true);
  const listing = await tool.run({ command: "Get-ChildItem -Force", timeoutMs: 1000 }, ctx);
  expect(listing.errorMessage).not.toContain("render_check");
  expect(listing.errorMessage).toContain("milliseconds");
  const server = await tool.run({ command: "npm run dev", timeoutMs: 1000 }, ctx);
  expect(server.errorMessage).toContain("render_check");
});
test("heading-as-control failures explain the assertion without weakening required interactions", () => {
  const probe = {
    observed: true,
    expectedTextPresent: true,
    controlFound: false,
    controlVisible: false,
    controlEnabled: false,
    controlOccluded: false,
    bodyText: "Scaffold ready",
    detail: "control not found",
  };
  const result = classifyControlAttempt(
    probe,
    { exitCode: 0, stderr: "" },
    {
      launchCommand: "npm run dev",
      url: "http://localhost:5173",
      expectedText: "Scaffold ready",
      expectedControl: "Scaffold ready",
      expectStyled: true,
    },
  );
  expect(result.kind).toBe("fail");
  expect(result.detail).toContain("Headings and static text belong in expectedText");
  expect(result.detail).toContain("keep the assertion and fix the missing control");
  const hidden = classifyControlAttempt(
    { ...probe, controlFound: true, controlOccluded: true },
    { exitCode: 0, stderr: "" },
    {
      launchCommand: "npm run dev",
      url: "http://localhost:5173",
      expectedControl: "Submit",
      expectedAfterText: "Saved",
      expectStyled: false,
    },
  );
  expect(hidden.kind).toBe("fail");
  expect(hidden.detail).not.toContain("omit expectedControl");
});
