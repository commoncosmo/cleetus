import { describe, expect, it } from "bun:test";
import { assertTagMatchesVersion } from "../../scripts/check-version";

describe("assertTagMatchesVersion", () => {
  it("accepts a v-prefixed tag that matches the version", () => {
    expect(() => assertTagMatchesVersion("v0.1.1", "0.1.1")).not.toThrow();
  });

  it("accepts a bare tag that matches the version", () => {
    expect(() => assertTagMatchesVersion("0.1.1", "0.1.1")).not.toThrow();
  });

  it("throws when tag and version differ", () => {
    expect(() => assertTagMatchesVersion("v0.1.1", "0.1.0")).toThrow("tag/version mismatch");
  });

  it("strips only a single leading v", () => {
    expect(() => assertTagMatchesVersion("vv0.1.1", "0.1.1")).toThrow("tag/version mismatch");
  });
});
