import type { RawSpecs } from "./schema";
import type { SpecsConfig } from "./types";

/** Merge global + project specs config (project-over-global). Default dir: docs/specs. */
export function resolveSpecs(global?: RawSpecs, project?: RawSpecs): SpecsConfig {
  return {
    dir: project?.dir ?? global?.dir ?? "docs/specs",
  };
}
