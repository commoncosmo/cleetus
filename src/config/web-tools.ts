import type { RawWebTools } from "./schema";
import type { WebSearchConfig, WebToolsConfig } from "./types";

export const DEFAULT_WEB_MAX_BYTES = 50000;

/**
 * Merge global + project web-tools config (project-over-global, per the sandbox pattern).
 * Defaults: enabled on (still permission-gated per call), localhost blocked, 50KB cap,
 * DuckDuckGo search. brave_api_key is omitted from the result when unset so the factory's
 * env fallback can apply.
 */
export function resolveWebTools(global?: RawWebTools, project?: RawWebTools): WebToolsConfig {
  const provider = project?.search?.provider ?? global?.search?.provider ?? "duckduckgo";
  const braveApiKey = project?.search?.brave_api_key ?? global?.search?.brave_api_key;
  const search: WebSearchConfig =
    braveApiKey === undefined ? { provider } : { provider, braveApiKey };
  return {
    enabled: project?.enabled ?? global?.enabled ?? true,
    allowLocalhost: project?.allow_localhost ?? global?.allow_localhost ?? false,
    maxBytes: project?.max_bytes ?? global?.max_bytes ?? DEFAULT_WEB_MAX_BYTES,
    search,
  };
}
