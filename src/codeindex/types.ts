export interface FileChunk {
  id: string; // `${relPath}#${index}`
  text: string;
  metadata: { path: string; startLine: number; endLine: number };
}

export interface ManifestEntry {
  hash: string;
  chunkCount: number;
}

export interface IndexProgress {
  phase: "scan" | "embed";
  done: number;
  total: number;
}

export interface IndexSummary {
  indexedFiles: number;
  indexedChunks: number;
  skipped: number; // unchanged files
  removed: number; // deleted files
  elapsedMs: number;
  rebuilt: boolean; // full rebuild ran (explicit or mismatch-triggered)
}
