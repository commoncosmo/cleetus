/** Discovery and capability probes run before the UI/first turn. Bound the entire HTTP
 * request, including the response body, so an offline provider cannot hold startup open.
 * Chat and embedding requests have separate lifetimes and do not use this deadline. */
export function fetchMetadata(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
}
