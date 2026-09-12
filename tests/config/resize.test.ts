import { describe, expect, it } from "bun:test";
import { DEFAULT_RESIZE, resolveResize } from "../../src/config/resize";

describe("resolveResize", () => {
  it("defaults to enabled with a 1568px cap when nothing is set", () => {
    expect(resolveResize()).toEqual(DEFAULT_RESIZE);
    expect(DEFAULT_RESIZE).toEqual({ enabled: true, maxDimension: 1568 });
  });

  it("takes project over global over default, per field", () => {
    const r = resolveResize(
      { enabled: false, max_dimension: 2048 }, // global
      { max_dimension: 1024 }, // project (enabled unset → falls to global)
    );
    expect(r).toEqual({ enabled: false, maxDimension: 1024 });
  });

  it("allows global to set a field the project leaves unset", () => {
    expect(resolveResize({ enabled: false }, {})).toEqual({ enabled: false, maxDimension: 1568 });
  });
});
