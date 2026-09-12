import { describe, expect, test } from "bun:test";
import { sanitizeTerminalText } from "../../src/ui/terminal-text";

describe("sanitizeTerminalText", () => {
  test("preserves ordinary Markdown, newlines, tabs, and Unicode", () => {
    expect(sanitizeTerminalText("# Forecast\n\n- 72°F\tpleasant")).toBe(
      "# Forecast\n\n- 72°F\tpleasant",
    );
  });

  test("removes ANSI styling, OSC links/titles, and control characters", () => {
    expect(
      sanitizeTerminalText(
        "\u001b[31mred\u001b[0m\u0000 \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007",
      ),
    ).toBe("red link");
  });
});
