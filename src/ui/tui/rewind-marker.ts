const MAX_LABEL = 40;

function shortLabel(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= MAX_LABEL ? clean : `${clean.slice(0, MAX_LABEL - 1)}…`;
}

export interface RewindMarker {
  userInput: string;
  revertedTurns: number;
  filesRestored: number;
  filesDeleted: number;
  todosCleared?: boolean;
  filesRestoreSkipped?: boolean;
}

/** One-line history marker for a completed rewind. */
export function formatRewindMarker(m: RewindMarker): string {
  const parts: string[] = [`${m.revertedTurns} turn${m.revertedTurns === 1 ? "" : "s"}`];
  if (m.filesRestored) parts.push(`${m.filesRestored} restored`);
  if (m.filesDeleted) parts.push(`${m.filesDeleted} deleted`);
  let s = `↩ reverted to "${shortLabel(m.userInput)}" (${parts.join(", ")})`;
  if (m.filesRestoreSkipped) s += " · files not restored";
  if (m.todosCleared) s += " · todos cleared";
  return s;
}
