import type { RawSubagents } from "./schema";
import type { SubagentsConfig } from "./types";

/** Merge global + project subagents config (project-over-global). Default: enabled. */
export function resolveSubagents(global?: RawSubagents, project?: RawSubagents): SubagentsConfig {
  return { enabled: project?.enabled ?? global?.enabled ?? true };
}
