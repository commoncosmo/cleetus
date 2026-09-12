import type { HookEntry } from "../hooks/types";
import type { RawHooks } from "./schema";

/** Merge global + project hook lists (global first). Maps snake_case `timeout_ms` to camelCase. */
export function resolveHooks(global?: RawHooks, project?: RawHooks): HookEntry[] {
  const toEntry = (h: RawHooks[number]): HookEntry => ({
    event: h.event,
    matcher: h.matcher,
    command: h.command,
    timeoutMs: h.timeout_ms,
  });
  return [...(global ?? []).map(toEntry), ...(project ?? []).map(toEntry)];
}
