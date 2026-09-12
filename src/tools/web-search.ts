import type { WebToolsConfig } from "../config/types";
import type { FetchFn } from "../web/fetch";
import { selectProvider } from "../web/search/factory";
import type { SearchResult } from "../web/search/types";
import type { Tool, ToolContext, ToolResult } from "./types";

interface Args {
  query: string;
}

const RESULT_LIMIT = 6;
const DEFAULT_WEB_TIMEOUT_MS = 30_000;

export interface WebSearchDeps {
  fetchFn?: FetchFn;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function render(results: SearchResult[]): string {
  if (results.length === 0) return "(no results)";
  return results
    .map((r, i) => `${i + 1}. **${clean(r.title)}** — ${r.url}\n   ${clean(r.snippet)}`.trimEnd())
    .join("\n");
}

export class WebSearchTool implements Tool {
  name = "web_search";
  description =
    "Search the web and return the top results (title, URL, snippet). Use to discover pages, then web_fetch a URL to read it.";
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
    required: ["query"],
  };

  constructor(
    private readonly cfg: WebToolsConfig,
    private readonly deps: WebSearchDeps = {},
  ) {}

  serialize(args: unknown): string {
    return `web_search "${(args as Args).query}"`;
  }

  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!this.cfg.enabled) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: "web tools are disabled" };
    }
    const selection = selectProvider(this.cfg.search, this.deps.env);
    if ("error" in selection) {
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage: selection.error };
    }
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_WEB_TIMEOUT_MS;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([ctx.abortSignal, timeout]);
    try {
      const results = await selection.provider.search((args as Args).query, {
        limit: RESULT_LIMIT,
        signal,
        fetchFn: this.deps.fetchFn,
      });
      return { ok: true, output: render(results) };
    } catch (e) {
      const errorMessage = timeout.aborted
        ? `timed out after ${timeoutMs}ms`
        : (e as Error).message;
      return { ok: false, errorCode: "TOOL_FAILED", errorMessage };
    }
  }
}
