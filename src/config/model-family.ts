import type { RawModelFamily } from "./schema";
import type { ModelFamilyConfig } from "./types";

/** Merge global + project model_family config (project-over-global). Default: enabled, no override. */
export function resolveModelFamily(
  global?: RawModelFamily,
  project?: RawModelFamily,
): ModelFamilyConfig {
  const enabled = project?.enabled ?? global?.enabled ?? true;
  const override = project?.override ?? global?.override;
  return override ? { enabled, override } : { enabled };
}
