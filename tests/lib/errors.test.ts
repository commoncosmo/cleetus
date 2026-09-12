import { describe, expect, it } from "bun:test";
import { CleetusError } from "../../src/lib/errors";

describe("CleetusError", () => {
  it("captures code and message", () => {
    const err = new CleetusError("CONFIG_INVALID", "bad config");
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.message).toBe("CONFIG_INVALID: bad config");
    expect(err).toBeInstanceOf(Error);
  });

  it("exposes optional cause", () => {
    const cause = new Error("inner");
    const err = new CleetusError("IO_FAILED", "wrap", { cause });
    expect(err.cause).toBe(cause);
  });
});
