import { describe, expect, test } from "bun:test";
import { resolvePackageManager } from "../../src/config/package-manager";

describe("resolvePackageManager", () => {
  test("defaults to enforcing Bun when nothing is set", () => {
    expect(resolvePackageManager(undefined, undefined)).toEqual({ enforceBun: true });
  });

  test("project overrides global (escape hatch)", () => {
    expect(resolvePackageManager({ enforce_bun: true }, { enforce_bun: false })).toEqual({
      enforceBun: false,
    });
  });

  test("falls back to global when project is unset", () => {
    expect(resolvePackageManager({ enforce_bun: false }, undefined)).toEqual({ enforceBun: false });
  });
});
