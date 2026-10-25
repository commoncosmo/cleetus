/** Locate unquoted command boundaries. This is a safety heuristic, not a shell parser. */
export function shellStatements(command: string, shell: "bash" | "powershell" = "bash"): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (
      (shell === "powershell" && c === "`") ||
      (shell === "bash" && c === "\\" && quote !== "'")
    ) {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (shell === "powershell" && command[i + 1] === quote) i++;
        else quote = "";
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    // Keep pipelines together: `Get-Item .git | Remove-Item` passes its
    // deletion target via stdin rather than an explicit Remove-Item argument.
    if (c === ";" || c === "\n" || (c === "|" && command[i + 1] === "|") || c === "&") {
      result.push(command.slice(start, i));
      if (c === "|") i++;
      start = i + 1;
    }
  }
  result.push(command.slice(start));
  return result.filter((s) => s.trim());
}
