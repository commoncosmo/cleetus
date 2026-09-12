export interface DiagnosticsRow {
  text: string;
  warn: boolean;
}

/** Split a diagnostics report string into display rows. Lines containing the ⚠ glyph
 *  are flagged `warn` (rendered with the warning color); others render dim. */
export function diagnosticsRows(text: string): DiagnosticsRow[] {
  return text.split("\n").map((line) => ({ text: line, warn: line.includes("⚠") }));
}
