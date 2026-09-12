import { describe, expect, it } from "bun:test";
import { SandboxUnavailableError } from "../../src/sandbox/types";

describe("SandboxUnavailableError", () => {
  it("prefixes the reason and sets the name", () => {
    const e = new SandboxUnavailableError("daemon down");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SandboxUnavailableError");
    expect(e.message).toBe("sandbox unavailable: daemon down");
  });
});
