import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDITOR_COMPATIBILITY_PROFILES,
  editorCompatibilityProfile,
  editorSmokeDocument,
  editorSmokePassed,
  profileSupportsPlatform,
  validateCompatibilityProfiles,
} from "../../src/editor/compatibility";
import { parseEditorWords } from "../../src/editor/words";

describe("editor compatibility profiles", () => {
  test("are internally valid and cover the promised editor families", () => {
    expect(validateCompatibilityProfiles()).toEqual([]);
    expect(EDITOR_COMPATIBILITY_PROFILES.map((profile) => profile.id)).toEqual([
      "vi",
      "vim",
      "nvim",
      "helix",
      "code-wait",
      "bbedit",
      "gvim",
      "macvim",
      "textedit",
    ]);
    expect(new Set(EDITOR_COMPATIBILITY_PROFILES.map((profile) => profile.id)).size).toBe(
      EDITOR_COMPATIBILITY_PROFILES.length,
    );
  });

  test("uses explicit wait/foreground flags for graphical editors", () => {
    expect(parseEditorWords(editorCompatibilityProfile("code-wait")!.command, "test")).toContain(
      "--wait",
    );
    expect(parseEditorWords(editorCompatibilityProfile("bbedit")!.command, "test")).toContain(
      "--wait",
    );
    expect(parseEditorWords(editorCompatibilityProfile("gvim")!.command, "test")).toContain("-f");
    expect(parseEditorWords(editorCompatibilityProfile("macvim")!.command, "test")).toContain("-f");
    expect(parseEditorWords(editorCompatibilityProfile("textedit")!.command, "test")).toContain(
      "-W",
    );
  });

  test("gates macOS-only launchers without restricting portable profiles", () => {
    expect(profileSupportsPlatform(editorCompatibilityProfile("vim")!, "linux")).toBe(true);
    expect(profileSupportsPlatform(editorCompatibilityProfile("helix")!, "win32")).toBe(true);
    expect(profileSupportsPlatform(editorCompatibilityProfile("bbedit")!, "darwin")).toBe(true);
    expect(profileSupportsPlatform(editorCompatibilityProfile("bbedit")!, "linux")).toBe(false);
    expect(profileSupportsPlatform(editorCompatibilityProfile("macvim")!, "darwin")).toBe(true);
    expect(profileSupportsPlatform(editorCompatibilityProfile("macvim")!, "linux")).toBe(false);
    expect(profileSupportsPlatform(editorCompatibilityProfile("textedit")!, "win32")).toBe(false);
  });

  test("requires the exact saved marker rather than a loose substring", () => {
    const document = editorSmokeDocument(editorCompatibilityProfile("vim")!);
    expect(editorSmokePassed(document)).toBe(false);
    expect(
      editorSmokePassed(document.replace("CLEETUS_EDITOR_SMOKE=pending", "almost passed")),
    ).toBe(false);
    expect(
      editorSmokePassed(
        document.replace("CLEETUS_EDITOR_SMOKE=pending", "CLEETUS_EDITOR_SMOKE=passed"),
      ),
    ).toBe(true);
  });

  test("reports malformed and duplicate custom profiles", () => {
    expect(
      validateCompatibilityProfiles([
        EDITOR_COMPATIBILITY_PROFILES[0]!,
        EDITOR_COMPATIBILITY_PROFILES[0]!,
        {
          ...EDITOR_COMPATIBILITY_PROFILES[0]!,
          id: "mismatch",
          executable: "other",
        },
      ]),
    ).toEqual([
      "duplicate profile id: vi",
      "profile 'mismatch' executable 'other' does not match command 'vi'",
    ]);
  });

  test("keeps the public matrix synchronized with every executable profile", () => {
    const documentation = readFileSync(join(import.meta.dir, "../../docs/editor.md"), "utf8");
    for (const profile of EDITOR_COMPATIBILITY_PROFILES) {
      const row = documentation.split("\n").find((line) => line.includes(`| \`${profile.id}\` |`));
      expect(row).toBeDefined();
      expect(row).toContain(profile.command);
    }
  });
});
