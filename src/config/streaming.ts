import type { RawStreaming } from "./schema";
import type { StreamingConfig } from "./types";

/**
 * Merge global + project streaming config (project-over-global, per the repo-map pattern).
 * Default: both on. `enabled` gates live token-by-token prose rendering; `reasoning` gates
 * the live reasoning-channel display + collapsed marker in the TUI.
 */
export function resolveStreaming(global?: RawStreaming, project?: RawStreaming): StreamingConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
    reasoning: project?.reasoning ?? global?.reasoning ?? true,
    reasoningLines: project?.reasoning_lines ?? global?.reasoning_lines ?? 10,
    proseLines: project?.prose_lines ?? global?.prose_lines ?? 12,
  };
}
