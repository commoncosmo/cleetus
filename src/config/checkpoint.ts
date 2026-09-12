import type { RawCheckpoint } from "./schema";
import type { CheckpointConfig } from "./types";

export const DEFAULT_CHECKPOINT_MAX_CHECKPOINTS = 20;

/** Merge global + project checkpoint config (project-over-global). Default: enabled. */
export function resolveCheckpoint(
  global?: RawCheckpoint,
  project?: RawCheckpoint,
): CheckpointConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
    maxCheckpoints:
      project?.max_checkpoints ?? global?.max_checkpoints ?? DEFAULT_CHECKPOINT_MAX_CHECKPOINTS,
  };
}
