import { expect, test } from "bun:test";
import {
  HOST_SANDBOX_PREFLIGHT_TIMEOUT_MS,
  preflightHostSandbox,
} from "../../src/sandbox/preflight";
import type { ExecOptions, ExecResult, Sandbox } from "../../src/sandbox/types";

function sandbox(result: ExecResult | Error): Pick<Sandbox, "exec"> {
  return {
    exec: async (_command: string, _opts: ExecOptions) => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const base: ExecResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
};

test("host-sandbox preflight accepts a clean command", async () => {
  expect(await preflightHostSandbox(sandbox(base))).toBeNull();
});

test("host-sandbox preflight reports a backend exit with its diagnostic", async () => {
  const result = await preflightHostSandbox(
    sandbox({ ...base, exitCode: 1, stderr: "bwrap: Creating new namespace failed" }),
  );
  expect(result).toBe("health check exited 1: bwrap: Creating new namespace failed");
});

test("host-sandbox preflight reports timeout and launch failure", async () => {
  expect(await preflightHostSandbox(sandbox({ ...base, timedOut: true, exitCode: 143 }))).toBe(
    `health check timed out after ${HOST_SANDBOX_PREFLIGHT_TIMEOUT_MS}ms`,
  );
  expect(await preflightHostSandbox(sandbox(new Error("sandbox-exec not found")))).toBe(
    "sandbox-exec not found",
  );
});
