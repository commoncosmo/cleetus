import { describe, expect, it } from "bun:test";
import { DEFAULT_MALFORMED_PATH, resolveMalformedPath } from "../../src/config/malformed-path";

describe("resolveMalformedPath", () => {
  it("defaults to enabled", () => {
    expect(resolveMalformedPath()).toEqual({ enabled: true });
    expect(DEFAULT_MALFORMED_PATH).toEqual({ enabled: true });
  });

  it("honours an explicit project-level false over a global true", () => {
    expect(resolveMalformedPath({ enabled: true }, { enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("falls back to global when project is absent", () => {
    expect(resolveMalformedPath({ enabled: false }, undefined)).toEqual({ enabled: false });
  });
});
