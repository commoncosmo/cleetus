import { describe, expect, it } from "bun:test";
import { resolveTheme, themes } from "../../src/ui/theme";

describe("resolveTheme", () => {
  it("returns the dark built-in unchanged when no overrides", () => {
    expect(resolveTheme("dark")).toEqual(themes.dark);
  });

  it("returns the light built-in for light", () => {
    expect(resolveTheme("light")).toEqual(themes.light);
  });

  it("uses the readable dark-terminal palette", () => {
    expect(themes.dark).toEqual({
      code: "#73daca",
      heading: "#7dcfff",
      rule: "#565f89",
      tableBorder: "#8089b3",
      dim: "#9399b2",
      userInput: "#9ece6a",
      toolLine: "#7aa2f7",
      success: "#9ece6a",
      error: "#f7768e",
      warning: "#e0af68",
      accent: "#7dcfff",
      accentAlt: "#bb9af7",
      syntax: {
        keyword: "#bb9af7",
        string: "#9ece6a",
        comment: "#565f89",
        number: "#ff9e64",
        function: "#7aa2f7",
        attr: "#7dcfff",
      },
    });
  });

  it("does not apply the dark-terminal palette to the light theme", () => {
    expect(themes.light).toEqual({
      code: "blue",
      heading: "blue",
      rule: "gray",
      tableBorder: "gray",
      dim: "gray",
      userInput: "green",
      toolLine: "gray",
      success: "green",
      error: "red",
      warning: "yellow",
      accent: "blue",
      accentAlt: "magenta",
      syntax: {
        keyword: "magenta",
        string: "green",
        comment: "gray",
        number: "yellow",
        function: "blue",
        attr: "blue",
      },
    });
  });

  it("applies a top-level role override", () => {
    const t = resolveTheme("dark", { code: "#73daca" });
    expect(t.code).toBe("#73daca");
    expect(t.heading).toBe(themes.dark.heading); // untouched
  });

  it("deep-merges syntax overrides, keeping un-overridden scopes", () => {
    const t = resolveTheme("dark", { syntax: { keyword: "#bb9af7" } });
    expect(t.syntax.keyword).toBe("#bb9af7");
    expect(t.syntax.string).toBe(themes.dark.syntax.string); // kept
  });

  it("falls back to dark for an unknown theme name", () => {
    // @ts-expect-error exercising the runtime fallback
    expect(resolveTheme("nope")).toEqual(themes.dark);
  });
});

describe("tableBorder role", () => {
  it("is defined on both built-in themes", () => {
    expect(typeof themes.dark.tableBorder).toBe("string");
    expect(typeof themes.light.tableBorder).toBe("string");
  });
  it("is brighter than rule by default on dark (distinct value)", () => {
    expect(themes.dark.tableBorder).not.toBe(themes.dark.rule);
  });
  it("accepts an override via resolveTheme", () => {
    expect(resolveTheme("dark", { tableBorder: "#8089b3" }).tableBorder).toBe("#8089b3");
  });
});
