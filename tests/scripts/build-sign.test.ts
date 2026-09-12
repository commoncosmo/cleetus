import { describe, expect, it } from "bun:test";
import { signCommand } from "../../scripts/build";

describe("signCommand", () => {
  it("uses Developer ID with hardened runtime + secure timestamp when an identity is given", () => {
    const args = signCommand(
      "Developer ID Application: Example Company (TEAMID)",
      "dist/cleetus-darwin-arm64",
    );
    expect(args).toEqual([
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      "Developer ID Application: Example Company (TEAMID)",
      "dist/cleetus-darwin-arm64",
    ]);
  });

  it("falls back to ad-hoc signing when no identity is given", () => {
    expect(signCommand(null, "dist/cleetus")).toEqual(["--force", "--sign", "-", "dist/cleetus"]);
  });
});
