import type { Suggestion } from "../ui/tui/input";
import type { SkillRegistry } from "./registry";

/**
 * Autocomplete candidates for a `/skill <partial>` line. Active ONLY while the skill
 * NAME is being typed — exactly one run of non-space characters after `/skill `. Once a
 * space follows the name (the user is into free-form args), returns [] so completion
 * never interferes. Filters skill names by case-insensitive substring (same policy as
 * completeModelLine / completeRouteLine). The value ends with a trailing space so the
 * user can keep typing arguments after the name is filled.
 */
export function completeSkillLine(registry: SkillRegistry, line: string): Suggestion[] {
  const m = /^\/skill\s+([^\s]*)$/.exec(line);
  if (!m) return [];
  const partial = m[1]!.toLowerCase();
  return registry
    .list()
    .filter((s) => s.name.toLowerCase().includes(partial))
    .map((s) => ({ display: `${s.name} — ${s.description}`, value: `/skill ${s.name} ` }));
}
