import { describe, expect, it } from "bun:test";
import { TARGETS, assetName } from "../../scripts/targets";

describe("TARGETS", () => {
  it("supports Unix and Windows build targets in order", () => {
    expect(TARGETS.map((t) => t.bunTarget)).toEqual([
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-windows-x64",
      "bun-windows-arm64",
    ]);
  });

  it("names each asset cleetus-<os>-<arch>", () => {
    expect(TARGETS.map((t) => t.asset)).toEqual([
      "cleetus-linux-x64",
      "cleetus-linux-arm64",
      "cleetus-darwin-arm64",
      "cleetus-darwin-x64",
      "cleetus-windows-x64.zip",
      "cleetus-windows-arm64.zip",
    ]);
  });

  it("labels darwin targets for the signing/notarization path", () => {
    expect(TARGETS.filter((t) => t.os === "darwin").map((t) => t.bunTarget)).toEqual([
      "bun-darwin-arm64",
      "bun-darwin-x64",
    ]);
  });
});

describe("assetName", () => {
  it("maps a bun target to its release asset name", () => {
    expect(assetName("bun-darwin-arm64")).toBe("cleetus-darwin-arm64");
    expect(assetName("bun-linux-x64")).toBe("cleetus-linux-x64");
  });

  it("throws on an unknown target", () => {
    expect(() => assetName("bun-freebsd-x64")).toThrow("unknown build target");
  });
});
