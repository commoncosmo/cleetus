import { describe, expect, it } from "bun:test";

const FILES = [
  "src/ui/markdown/Markdown.tsx",
  "src/ui/markdown/MarkdownTable.tsx",
  "src/ui/tui/history.tsx",
];
// Any string-literal color is a theme bypass; themed colors use color={...} expressions.
const LITERAL = /(?:color|borderColor)="[^"]+"/;

describe("content components use the theme, not color literals", () => {
  for (const f of FILES) {
    it(`${f} has no hardcoded color props`, async () => {
      const src = await Bun.file(f).text();
      expect(src).not.toMatch(LITERAL);
    });
    it(`${f} imports useTheme`, async () => {
      const src = await Bun.file(f).text();
      expect(src).toContain("useTheme");
    });
  }
});
