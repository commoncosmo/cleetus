import { describe, expect, it } from "bun:test";

const FILES = [
  "src/ui/tui/status-bar.tsx",
  "src/ui/tui/input.tsx",
  "src/ui/tui/busy-indicator.tsx",
  "src/ui/tui/command-panel.tsx",
  "src/ui/tui/permission-prompt.tsx",
  "src/ui/diff/DiffView.tsx",
  "src/ui/tui/model-picker-modal.tsx",
  "src/ui/tui/mode-picker-modal.tsx",
  "src/ui/tui/route-picker-modal.tsx",
  "src/ui/tui/persona-picker-modal.tsx",
  "src/ui/tui/personality-picker-modal.tsx",
];
// Any string-literal color is a theme bypass; themed colors use color={...} expressions.
const LITERAL = /(?:color|borderColor)="[^"]+"/;

describe("chrome + modal components use the theme", () => {
  for (const f of FILES) {
    it(`${f} has no hardcoded color props`, async () => {
      expect(await Bun.file(f).text()).not.toMatch(LITERAL);
    });
    it(`${f} imports useTheme`, async () => {
      expect(await Bun.file(f).text()).toContain("useTheme");
    });
  }
  it("bin wraps the app in a ThemeProvider", async () => {
    const src = await Bun.file("src/bin/cleetus.ts").text();
    expect(src).toContain("ThemeProvider");
    expect(src).toContain("resolveTheme");
  });
});
