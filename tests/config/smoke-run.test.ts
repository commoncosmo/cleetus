import { expect, test } from "bun:test";
import { DEFAULT_SMOKE_RUN, resolveSmokeRun } from "../../src/config/smoke-run";

test("defaults", () => {
  expect(DEFAULT_SMOKE_RUN).toEqual({ defaultSeconds: 10, maxSeconds: 30, maxOutputLines: 100 });
});

test("project overrides global", () => {
  const c = resolveSmokeRun({ default_seconds: 5 }, { max_seconds: 60 });
  expect(c.defaultSeconds).toBe(5); // global (project undefined)
  expect(c.maxSeconds).toBe(60); // project
  expect(c.maxOutputLines).toBe(100); // default
});
