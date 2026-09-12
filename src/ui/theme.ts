import { createContext, useContext } from "react";

/** A code-block syntax-highlighting palette (one color per hljs scope group). */
export interface SyntaxColors {
  keyword: string; // keyword, built_in, literal
  string: string; // string, regexp, char
  comment: string; // comment
  number: string; // number
  function: string; // title, function, title.function
  attr: string; // attr, attribute, property
}

/** Semantic UI roles → Ink-compatible color (named ANSI or hex string). */
export interface Theme {
  code: string; // inline code — the readability fix
  heading: string; // markdown headings
  rule: string; // heading underline, ---
  tableBorder: string; // grid lines of markdown tables (brighter than rule)
  dim: string; // status bar, hints, descriptions, "↑ N more", blockquote
  userInput: string; // "› your prompt", input prompt
  toolLine: string; // "bash ls -F ✓" tool-call lines
  success: string; // [y]es, diff additions
  error: string; // errors, [n]o, dangerous modes, ⚠ fuckit, diff removals
  warning: string; // permission-prompt header / border
  accent: string; // selected row in pickers
  accentAlt: string; // [g]lobal key hint
  syntax: SyntaxColors;
}

/** Deep-partial of Theme, used for config overrides. */
export type ThemeOverrides = Partial<Omit<Theme, "syntax">> & {
  syntax?: Partial<SyntaxColors>;
};

export type ThemeName = "dark" | "light";

const dark: Theme = {
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
};

const light: Theme = {
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
};

export const themes: Record<ThemeName, Theme> = { dark, light };

/** Built-in theme + overrides → active Theme. Unknown name falls back to dark. */
export function resolveTheme(name: ThemeName, overrides?: ThemeOverrides): Theme {
  const base = themes[name] ?? themes.dark;
  if (!overrides) return base;
  const { syntax, ...top } = overrides;
  return {
    ...base,
    ...top,
    syntax: syntax ? { ...base.syntax, ...syntax } : base.syntax,
  };
}

const ThemeContext = createContext<Theme>(themes.dark);
export const ThemeProvider = ThemeContext.Provider;
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
