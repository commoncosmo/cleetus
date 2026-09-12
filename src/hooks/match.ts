import type { HookEntry, HookEvent } from "./types";

/** The entries whose event matches and whose matcher regex tests true (or is absent),
 *  in declaration order. An invalid matcher regex never matches (config also validates it). */
export function matchHooks(entries: HookEntry[], event: HookEvent, toolName: string): HookEntry[] {
  return entries.filter((e) => {
    if (e.event !== event) return false;
    if (!e.matcher) return true;
    try {
      return new RegExp(e.matcher).test(toolName);
    } catch {
      return false;
    }
  });
}
