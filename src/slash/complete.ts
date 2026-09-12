import type { Suggestion } from "../ui/tui/input";
import type { CommandRegistry } from "./commands";

interface Candidate {
  /** Token shown/typed after the slash (command name or alias). */
  token: string;
  display: string;
  value: string;
  fillOnly?: boolean;
}

/**
 * Command-name completions for a slash line. Returns [] unless the line is a
 * single line starting with "/" with no space yet (the command name is still
 * being typed). Matches command names and aliases by case-insensitive prefix.
 * Required-argument commands are returned fill-only with a trailing-space value
 * so the user can type the argument. Optional-argument commands retain the
 * trailing space but run immediately on Enter.
 */
export function completeSlashLine(commands: CommandRegistry, line: string): Suggestion[] {
  if (!line.startsWith("/") || line.includes("\n") || line.includes(" ")) return [];
  const partial = line.slice(1).toLowerCase();

  const candidates: Candidate[] = [];
  for (const cmd of commands.all()) {
    const argSuffix = cmd.takesArgs ? " " : "";
    candidates.push({
      token: cmd.name,
      display: `/${cmd.name} — ${cmd.description}`,
      value: `/${cmd.name}${argSuffix}`,
      fillOnly: cmd.takesArgs && !cmd.argsOptional,
    });
    for (const alias of cmd.aliases ?? []) {
      candidates.push({
        token: alias,
        display: `/${alias} — alias for /${cmd.name}`,
        value: `/${alias}${argSuffix}`,
        fillOnly: cmd.takesArgs && !cmd.argsOptional,
      });
    }
  }

  return candidates
    .filter((c) => c.token.toLowerCase().startsWith(partial))
    .sort((a, b) => a.token.localeCompare(b.token))
    .map(({ display, value, fillOnly }) =>
      fillOnly ? { display, value, fillOnly } : { display, value },
    );
}
