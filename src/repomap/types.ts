export type SymbolKind = "function" | "class" | "const" | "type" | "struct" | "interface";

export interface RepoSymbol {
  name: string;
  kind: SymbolKind;
  line: number; // 1-based, the line the declaration starts on
}

export interface FileSymbols {
  path: string; // repo-relative
  symbols: RepoSymbol[];
}

export interface CacheEntry {
  hash: string;
  symbols: RepoSymbol[];
}

/** path → cache entry. Persisted as JSON at .cleetus/repomap.json */
export type RepoMapCache = Record<string, CacheEntry>;
