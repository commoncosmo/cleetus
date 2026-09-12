import type { RawTest } from "./schema";
import type { TestConfig } from "./types";

export const DEFAULT_TEST_TIMEOUT_MS = 120_000;
export const DEFAULT_TEST_MAX_OUTPUT_LINES = 120;

/** Merge global + project test config (project-over-global). Default: enabled. */
export function resolveTest(global?: RawTest, project?: RawTest): TestConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
    command: project?.command ?? global?.command,
    timeoutMs: project?.timeout_ms ?? global?.timeout_ms ?? DEFAULT_TEST_TIMEOUT_MS,
    maxOutputLines:
      project?.max_output_lines ?? global?.max_output_lines ?? DEFAULT_TEST_MAX_OUTPUT_LINES,
  };
}
