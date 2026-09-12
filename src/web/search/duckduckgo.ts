import type { SearchOptions, SearchProvider, SearchResult } from "./types";

const ENDPOINT = "https://html.duckduckgo.com/html/";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Unwrap DuckDuckGo redirect links (/l/?uddg=ENCODED) to the real target. */
function unwrap(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return href.startsWith("//") ? `https:${href}` : href;
}

/**
 * Parse DuckDuckGo's HTML-endpoint result markup. Intentionally tolerant but inherently
 * brittle: DuckDuckGo can change its markup at any time. That fragility is why the Brave
 * provider (stable JSON API) is the recommended configured path. Uses matchAll (not
 * exec-in-while) to satisfy biome's noAssignInExpressions rule.
 */
export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];
  const snippets = [...html.matchAll(snippetRe)];
  const results: SearchResult[] = [];
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const a = anchors[i];
    if (!a) continue;
    const start = a.index ?? 0;
    const nextStart = anchors[i + 1]?.index ?? html.length;
    // pair with the first snippet that appears between this anchor and the next one,
    // so a result with no snippet doesn't steal the next result's snippet
    const snip = snippets.find((s) => (s.index ?? -1) > start && (s.index ?? -1) < nextStart);
    results.push({
      title: stripTags(a[2] ?? ""),
      url: unwrap(decodeEntities(a[1] ?? "")),
      snippet: snip ? stripTags(snip[1] ?? "") : "",
    });
  }
  return results;
}

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = "duckduckgo";

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const fetchFn = opts.fetchFn ?? fetch;
    const url = new URL(ENDPOINT);
    url.searchParams.set("q", query);
    const res = await fetchFn(url, {
      method: "GET",
      signal: opts.signal,
      headers: {
        "user-agent": "cleetus-web-search/1.0",
      },
    });
    if (res.status !== 200) {
      throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
    }
    const html = await res.text();
    if (/id=["']challenge-form["']|data-testid=["']anomaly-modal["']/i.test(html)) {
      throw new Error("DuckDuckGo search was temporarily challenged; retry later");
    }
    return parseDuckDuckGo(html, opts.limit);
  }
}
