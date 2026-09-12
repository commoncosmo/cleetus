import { describe, expect, it } from "bun:test";
import { detectHostBackend } from "../../src/sandbox/detect";

describe("detectHostBackend", () => {
  it("returns seatbelt on macOS", () => {
    expect(detectHostBackend("darwin", () => false)).toBe("seatbelt");
  });

  it("returns bwrap on Linux only when bwrap is on PATH", () => {
    expect(detectHostBackend("linux", () => true)).toBe("bwrap");
    expect(detectHostBackend("linux", () => false)).toBeNull();
  });

  it("returns null on Windows and other platforms", () => {
    expect(detectHostBackend("win32", () => true)).toBeNull();
    expect(detectHostBackend("freebsd", () => true)).toBeNull();
  });
});
