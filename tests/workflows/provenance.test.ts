import { describe, expect, it } from "bun:test";
import {
  mergeProvenance,
  provenance,
  redactResolved,
  resolved,
} from "../../src/workflows/provenance";

describe("workflow value provenance", () => {
  it("merges flags and stable unique origins", () => {
    expect(
      mergeProvenance([
        provenance({ untrusted: true, origins: ["http", "input"] }),
        provenance({ sensitive: true, origins: ["secret", "input"] }),
      ]),
    ).toEqual({
      untrusted: true,
      sensitive: true,
      origins: ["http", "input", "secret"],
    });
  });

  it("redacts sensitive values conservatively", () => {
    expect(redactResolved(resolved({ token: "abc" }, { sensitive: true }))).toBe("[REDACTED]");
    expect(redactResolved(resolved("public"))).toBe("public");
  });
});
