import type { RawMalformedPath } from "./schema";

/** Reject high-confidence corrupted model-emitted paths (near-misses to the project root)
 *  before the out-of-tree permission prompt. */
export interface MalformedPathConfig {
  enabled: boolean;
}

export const DEFAULT_MALFORMED_PATH: MalformedPathConfig = {
  enabled: true,
};

/** Resolve with project > global > default precedence. Pure. */
export function resolveMalformedPath(
  global?: RawMalformedPath,
  project?: RawMalformedPath,
): MalformedPathConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_MALFORMED_PATH.enabled,
  };
}
