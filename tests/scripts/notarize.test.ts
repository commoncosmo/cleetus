import { describe, expect, it } from "bun:test";
import { notarytoolArgs } from "../../scripts/notarize";

describe("notarytoolArgs", () => {
  it("builds a `notarytool submit --wait` argv from App Store Connect API-key auth", () => {
    expect(
      notarytoolArgs("dist/cleetus-darwin-arm64.zip", {
        p8Path: "/tmp/ac_key.p8",
        keyId: "ABC123",
        issuerId: "issuer-uuid",
      }),
    ).toEqual([
      "notarytool",
      "submit",
      "dist/cleetus-darwin-arm64.zip",
      "--key",
      "/tmp/ac_key.p8",
      "--key-id",
      "ABC123",
      "--issuer",
      "issuer-uuid",
      "--wait",
    ]);
  });
});
