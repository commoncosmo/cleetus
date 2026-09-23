import { describe, expect, test } from "bun:test";
import { BUILTIN_DEFAULTS } from "../../src/permission/types";

describe("BUILTIN_DEFAULTS", () => {
  test("the task (subagent) tool defaults to ask", () => {
    expect(BUILTIN_DEFAULTS.task).toBe("ask");
  });

  test("the smoke_run tool defaults to ask", () => {
    expect(BUILTIN_DEFAULTS.smoke_run).toBe("ask");
  });

  test("client job starts are gated while owned-job safety operations are allowed", () => {
    expect(BUILTIN_DEFAULTS.job_start).toBe("ask");
    expect(BUILTIN_DEFAULTS.job_status).toBe("allow");
    expect(BUILTIN_DEFAULTS.job_cancel).toBe("allow");
    expect(BUILTIN_DEFAULTS.job_artifact_read).toBe("allow");
  });

  test("deterministic owned-artifact normalization is allowed by default", () => {
    expect(BUILTIN_DEFAULTS.job_artifact_normalize).toBe("allow");
  });
});
