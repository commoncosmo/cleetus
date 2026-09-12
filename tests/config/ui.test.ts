import { describe, expect, it } from "bun:test";
import { resolveUi } from "../../src/config/ui";

describe("resolveUi", () => {
  it("defaults to dark theme with no overrides", () => {
    expect(resolveUi(undefined, undefined)).toEqual({ theme: "dark", colors: {} });
  });

  it("maps snake_case override keys to camelCase roles", () => {
    const r = resolveUi(undefined, {
      theme: "light",
      colors: { code: "#73daca", user_input: "#9ece6a", accent_alt: "#bb9af7" },
    });
    expect(r.theme).toBe("light");
    expect(r.colors).toEqual({ code: "#73daca", userInput: "#9ece6a", accentAlt: "#bb9af7" });
  });

  it("merges project over global (project wins per role)", () => {
    const r = resolveUi(
      { theme: "dark", colors: { code: "#111111", heading: "#222222" } },
      { colors: { code: "#999999" } },
    );
    expect(r.theme).toBe("dark"); // from global, project unset
    expect(r.colors.code).toBe("#999999"); // project wins
    expect(r.colors.heading).toBe("#222222"); // from global
  });

  it("deep-merges the syntax sub-map", () => {
    const r = resolveUi(
      { colors: { syntax: { keyword: "#aaa", string: "#bbb" } } },
      { colors: { syntax: { keyword: "#ccc" } } },
    );
    expect(r.colors.syntax).toEqual({ keyword: "#ccc", string: "#bbb" });
  });
});

describe("table_border resolution", () => {
  it("maps snake_case table_border to the tableBorder role", () => {
    const ui = resolveUi({ colors: { table_border: "#8089b3" } }, undefined);
    expect(ui.colors.tableBorder).toBe("#8089b3");
  });
  it("lets project override global for table_border", () => {
    const ui = resolveUi(
      { colors: { table_border: "#111111" } },
      { colors: { table_border: "#222222" } },
    );
    expect(ui.colors.tableBorder).toBe("#222222");
  });
});
