import { describe, expect, it } from "bun:test";
import { parsePids, sentinelMarker } from "../../src/sandbox/docker-teardown";

describe("docker-teardown helpers", () => {
  it("builds the argv marker from a sentinel", () => {
    expect(sentinelMarker("abc-123")).toBe("#CLEETUS_RUN=abc-123");
  });

  it("parses pgrep stdout into a numeric pid list", () => {
    expect(parsePids("4821\n4830\n")).toEqual([4821, 4830]);
  });

  it("ignores blank lines and non-numeric noise", () => {
    expect(parsePids("\n12\n  \nfoo\n34\n")).toEqual([12, 34]);
  });

  it("returns [] for empty output", () => {
    expect(parsePids("")).toEqual([]);
  });
});
