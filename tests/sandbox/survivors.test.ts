import { describe, expect, it } from "bun:test";
import { survivorWarning } from "../../src/sandbox/survivors";

describe("survivorWarning", () => {
  it("returns null when there are no survivors", () => {
    expect(survivorWarning(undefined)).toBeNull();
    expect(survivorWarning([])).toBeNull();
  });

  it("names the count and pids when processes survived", () => {
    const w = survivorWarning([4821, 4830]);
    expect(w).toContain("2 process(es) survived teardown");
    expect(w).toContain("4821, 4830");
  });
});
