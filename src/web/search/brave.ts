import type { SearchOptions, SearchProvider, SearchResult } from "./types";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

export class BraveProvider implements SearchProvider {
  readonly name = "brave";

  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const fetchFn = opts.fetchFn ?? fetch;
    const url = `${ENDPOINT}?${new URLSearchParams({ q: query, count: String(opts.limit) })}`;
    const res = await fetchFn(url, {
      signal: opts.signal,
      headers: {
        accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
    });
    if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
    const json = (await res.json()) as BraveResponse;
    const results = json.web?.results ?? [];
    return results.slice(0, opts.limit).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  }
}
