import type { FetchFn } from "../fetch";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  limit: number;
  signal?: AbortSignal;
  fetchFn?: FetchFn;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
