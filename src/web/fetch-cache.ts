export interface CachedFetch {
  body: string;
  finalUrl: string;
  /** False when web_fetch capped the response before caching it. Exact-save tools must refuse it. */
  complete?: boolean;
}

/** Normalize a URL for cache keying: trim and drop the #fragment (anchors don't change
 *  the fetched document); the query string is preserved. Pure. */
export function normalizeCacheKey(url: string): string {
  const trimmed = url.trim();
  const hash = trimmed.indexOf("#");
  return hash === -1 ? trimmed : trimmed.slice(0, hash);
}

/**
 * In-memory, session-scoped, URL-keyed cache for successful web_fetch results. Bounded
 * with LRU eviction (Map insertion order). Not persisted — lives for the process/session.
 */
export class WebFetchCache {
  private readonly map = new Map<string, CachedFetch>();

  constructor(private readonly maxEntries = 64) {}

  get(url: string): CachedFetch | undefined {
    const key = normalizeCacheKey(url);
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // refresh recency: re-insert at the end (most-recently-used)
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(url: string, value: CachedFetch): void {
    const key = normalizeCacheKey(url);
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
