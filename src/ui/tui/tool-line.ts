export interface ToolCallLike {
  name: string;
  args?: unknown;
}

export interface ToolResultLike {
  ok: boolean;
  errorMessage?: string;
}

const MAX_SUMMARY = 60;

/**
 * A short, single-line summary of a tool call's arguments for the transcript.
 * Picks the most relevant string arg across the built-in tools (bash → command,
 * read/write/edit → path, grep/glob → pattern); returns "" when none applies.
 */
export function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.command ?? a.path ?? a.pattern ?? a.file ?? a.filePath;
  if (typeof pick !== "string") return "";
  const oneLine = pick.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY ? `${oneLine.slice(0, MAX_SUMMARY - 1)}…` : oneLine;
}

/**
 * One-line transcript rendering of a tool call: `⚙ <name> <argSummary>` with a
 * trailing `✓`/`✗` once the result is known (no glyph while still running).
 */
export function formatToolLine(call: ToolCallLike, result?: ToolResultLike): string {
  const summary = toolArgSummary(call.args);
  const head = `⚙ ${call.name}${summary ? ` ${summary}` : ""}`;
  if (!result) return head;
  return `${head} ${result.ok ? "✓" : "✗"}`;
}
