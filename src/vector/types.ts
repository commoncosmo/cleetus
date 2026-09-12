export type Scope = "project" | "global";

export interface VectorRecord {
  id: string;
  text: string;
  metadata?: unknown;
}

export interface VectorHit {
  id: string;
  text: string;
  metadata?: unknown;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

export interface NamespaceStats {
  count: number;
  /** Embedding model that built this namespace; undefined if never written. */
  model?: string;
  dim?: number;
}
