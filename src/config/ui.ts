import type { ThemeName, ThemeOverrides } from "../ui/theme";
import type { RawUi } from "./schema";
import type { UiConfig } from "./types";

// "syntax" is intentionally excluded here — it is a nested object deep-merged separately below.
const COLOR_KEYS: [keyof NonNullable<RawUi["colors"]>, keyof Omit<ThemeOverrides, "syntax">][] = [
  ["code", "code"],
  ["heading", "heading"],
  ["rule", "rule"],
  ["dim", "dim"],
  ["user_input", "userInput"],
  ["tool_line", "toolLine"],
  ["success", "success"],
  ["error", "error"],
  ["warning", "warning"],
  ["accent", "accent"],
  ["accent_alt", "accentAlt"],
  ["table_border", "tableBorder"],
];

/**
 * Merge global + project UI config (project-over-global, per the sandbox pattern).
 * Translates snake_case override keys to the camelCase Theme roles. Default theme: dark.
 */
export function resolveUi(global?: RawUi, project?: RawUi): UiConfig {
  const theme: ThemeName = project?.theme ?? global?.theme ?? "dark";
  const gc = global?.colors;
  const pc = project?.colors;
  const colors: ThemeOverrides = {};
  for (const [raw, role] of COLOR_KEYS) {
    const v = pc?.[raw] ?? gc?.[raw];
    if (typeof v === "string") colors[role] = v;
  }
  const syntax = { ...(gc?.syntax ?? {}), ...(pc?.syntax ?? {}) };
  if (Object.keys(syntax).length > 0) colors.syntax = syntax;
  return { theme, colors };
}
