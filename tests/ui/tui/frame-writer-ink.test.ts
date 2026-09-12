import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Runs the real-Ink integration probe in its own process.
 *
 * It cannot run in-process: Ink disables its entire frame path when `is-in-ci` detects CI, and
 * `is-in-ci` resolves once at import time. Bun shares the module registry across test files and
 * many of them pull Ink in transitively, so by the time this file executes the decision is already
 * made. A fresh process with the CI markers stripped gets the real render path on every machine.
 *
 * See ./ink-proxy-probe.tsx for the assertions.
 */
test("the frame-writer proxy drives real Ink correctly", async () => {
  const probe = join(import.meta.dir, "ink-proxy-probe.tsx");

  // Strip the markers `is-in-ci` looks for, so the child exercises Ink's real frame path.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "CI" || key === "CONTINUOUS_INTEGRATION" || key.startsWith("CI_")) continue;
    if (value !== undefined) env[key] = value;
  }

  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn("bun", [probe], { env, stdio: ["ignore", "ignore", "pipe"] });
    let captured = "";
    child.stderr.on("data", (chunk) => {
      captured += String(chunk);
    });
    child.on("close", (exitCode) => resolve({ code: exitCode, stderr: captured }));
  });

  // Ink's cli-cursor writes cursor escapes to stderr, so stderr is never empty — the exit code is
  // the verdict, and stderr carries the probe's assertion message when it fails.
  if (code !== 0) throw new Error(`ink proxy probe failed:\n${stderr.trim()}`);
  expect(code).toBe(0);
}, 30_000);
