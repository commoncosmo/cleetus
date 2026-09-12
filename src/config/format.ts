import type { RawFormat } from "./schema";
import type { FormatConfig } from "./types";

/** Merge global + project format config (project-over-global). Default: enabled. */
export function resolveFormat(global?: RawFormat, project?: RawFormat): FormatConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
  };
}
