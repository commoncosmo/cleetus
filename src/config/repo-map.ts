import type { RawRepoMap } from "./schema";
import type { RepoMapConfig } from "./types";

export const DEFAULT_REPO_MAP_TOKEN_BUDGET = 1500;

/**
 * Merge global + project repo-map config (project-over-global, per the web-tools pattern).
 * Default: enabled, 1500-token injection budget.
 */
export function resolveRepoMap(global?: RawRepoMap, project?: RawRepoMap): RepoMapConfig {
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
    tokenBudget: project?.token_budget ?? global?.token_budget ?? DEFAULT_REPO_MAP_TOKEN_BUDGET,
  };
}
