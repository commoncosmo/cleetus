import type { RawSkills } from "./schema";
import type { SkillsConfig } from "./types";

/** Merge global + project skills config (project-over-global). Defaults: enabled + autoInvoke. */
export function resolveSkills(global?: RawSkills, project?: RawSkills): SkillsConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
    autoInvoke: project?.auto_invoke ?? global?.auto_invoke ?? true,
  };
}
