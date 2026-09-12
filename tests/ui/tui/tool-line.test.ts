import { describe, expect, it } from "bun:test";
import { formatToolLine, toolArgSummary } from "../../../src/ui/tui/tool-line";

describe("toolArgSummary", () => {
  it("picks the command for bash", () => {
    expect(toolArgSummary({ command: "ls -la" })).toBe("ls -la");
  });
  it("picks the path for file tools", () => {
    expect(toolArgSummary({ path: "src/x.ts" })).toBe("src/x.ts");
  });
  it("picks the pattern for grep/glob", () => {
    expect(toolArgSummary({ pattern: "*.ts" })).toBe("*.ts");
  });
  it("collapses whitespace to a single line", () => {
    expect(toolArgSummary({ command: "a\n  b\tc" })).toBe("a b c");
  });
  it("truncates long summaries with an ellipsis", () => {
    const long = "x".repeat(100);
    const out = toolArgSummary({ command: long });
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns empty string when no recognized arg is present", () => {
    expect(toolArgSummary({ foo: 1 })).toBe("");
    expect(toolArgSummary(undefined)).toBe("");
    expect(toolArgSummary(null)).toBe("");
  });
});

describe("formatToolLine", () => {
  it("renders a running call with no status glyph", () => {
    expect(formatToolLine({ name: "bash", args: { command: "ls" } })).toBe("⚙ bash ls");
  });
  it("appends ✓ on success", () => {
    expect(formatToolLine({ name: "bash", args: { command: "ls" } }, { ok: true })).toBe(
      "⚙ bash ls ✓",
    );
  });
  it("appends ✗ on failure", () => {
    expect(formatToolLine({ name: "bash", args: { command: "ls" } }, { ok: false })).toBe(
      "⚙ bash ls ✗",
    );
  });
  it("omits the summary when there is none", () => {
    expect(formatToolLine({ name: "bash" })).toBe("⚙ bash");
  });
});
