import { BraveProvider } from "./brave";
import { DuckDuckGoProvider } from "./duckduckgo";
import type { SearchProvider } from "./types";

export interface SearchSelection {
  provider: "duckduckgo" | "brave";
  braveApiKey?: string;
}

export type SelectResult = { provider: SearchProvider } | { error: string };

const NO_BRAVE_KEY_ERROR =
  "Brave search selected but no API key found. Set web_tools.search.brave_api_key " +
  "or the BRAVE_SEARCH_API_KEY env var, or use provider: duckduckgo.";

/**
 * Pick a search provider. Brave is used when a key is available (config value, else
 * BRAVE_SEARCH_API_KEY env). Explicitly choosing brave without a key is a clear error;
 * otherwise we fall back to DuckDuckGo.
 */
export function selectProvider(
  cfg: SearchSelection,
  env: Record<string, string | undefined> = process.env,
): SelectResult {
  const key = cfg.braveApiKey || env.BRAVE_SEARCH_API_KEY;
  if (key) return { provider: new BraveProvider(key) };
  if (cfg.provider === "brave") {
    return { error: NO_BRAVE_KEY_ERROR };
  }
  return { provider: new DuckDuckGoProvider() };
}
