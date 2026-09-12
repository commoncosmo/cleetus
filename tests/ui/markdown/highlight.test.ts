import { describe, expect, it } from "bun:test";
import { highlightCode } from "../../../src/ui/markdown/highlight";
import { themes } from "../../../src/ui/theme";

const lineText = (line: { text: string }[]) => line.map((s) => s.text).join("");

describe("highlightCode", () => {
  it("returns one StyledLine per source line", () => {
    const out = highlightCode("const a = 1;\nconst b = 2;", "ts");
    expect(out).toHaveLength(2);
    expect(lineText(out[0]!)).toBe("const a = 1;");
    expect(lineText(out[1]!)).toBe("const b = 2;");
  });

  it("produces at least one colored span for a known language", () => {
    const out = highlightCode("const a = 1;", "ts");
    const spans = out.flat();
    expect(spans.some((s) => s.color !== undefined)).toBe(true);
  });

  it("preserves text exactly (no chars added or dropped)", () => {
    const src = "function f(x) { return x + 1; }";
    const out = highlightCode(src, "js");
    expect(out.map(lineText).join("\n")).toBe(src);
  });

  it("falls back to uncolored spans for an unknown language", () => {
    const out = highlightCode("some plain text", "not-a-language");
    expect(out).toHaveLength(1);
    expect(lineText(out[0]!)).toBe("some plain text");
    expect(out[0]!.every((s) => s.color === undefined)).toBe(true);
  });

  it("falls back to uncolored when no language is given", () => {
    const out = highlightCode("plain", undefined);
    expect(lineText(out[0]!)).toBe("plain");
    expect(out[0]!.every((s) => s.color === undefined)).toBe(true);
  });

  it("does not throw on empty input", () => {
    expect(() => highlightCode("", "ts")).not.toThrow();
  });
});

describe("highlightCode with custom syntax colors", () => {
  it("uses the injected palette for colored scopes", () => {
    const custom = { ...themes.dark.syntax, keyword: "#ff0000" };
    const out = highlightCode("const a = 1;", "ts", custom);
    const colors = out.flat().map((s) => s.color);
    expect(colors.some((c) => Object.values(custom).includes(c as string))).toBe(true);
    expect(colors).not.toContain("magenta"); // dark default keyword was overridden away
  });

  it("defaults to the dark syntax palette when none injected", () => {
    const withDefault = highlightCode("const a = 1;", "ts");
    const withExplicit = highlightCode("const a = 1;", "ts", themes.dark.syntax);
    expect(withDefault).toEqual(withExplicit);
  });
});
