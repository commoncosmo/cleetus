import { describe, expect, test } from "bun:test";
import { resolveSubagents } from "../../src/config/subagents";

describe("resolveSubagents", () => {
  test("defaults to enabled when nothing is set", () => {
    expect(resolveSubagents(undefined, undefined)).toEqual({ enabled: true });
  });

  test("project overrides global", () => {
    expect(resolveSubagents({ enabled: true }, { enabled: false })).toEqual({ enabled: false });
  });

  test("falls back to global when project is unset", () => {
    expect(resolveSubagents({ enabled: false }, undefined)).toEqual({ enabled: false });
  });
});
