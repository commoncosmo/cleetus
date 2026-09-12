import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VectorService } from "../vector/service";
import { chunkFile } from "./chunk";
import { enumerateFiles } from "./enumerate";
import type { Manifest } from "./manifest";
import type { IndexProgress, IndexSummary } from "./types";

const NAMESPACE = "code";

function sha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function chunkIds(path: string, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(`${path}#${i}`);
  return ids;
}

export interface IndexerOptions {
  projectDir: string;
  vectorService: VectorService;
  manifest: Manifest;
  /** Configured embedding model name (`embedder.model`), or "" when embeddings are disabled. */
  embedModel: string;
}

export class Indexer {
  constructor(private readonly opts: IndexerOptions) {}

  async run(
    opts: { rebuild?: boolean; onProgress?: (p: IndexProgress) => void } = {},
  ): Promise<IndexSummary> {
    const { projectDir, vectorService, manifest, embedModel } = this.opts;
    const startedAt = Date.now();

    const files = await enumerateFiles(projectDir);
    opts.onProgress?.({ phase: "scan", done: files.length, total: files.length });

    // Rebuild when explicitly requested OR the embedding model changed since last index.
    const stamp = vectorService.stats("project", NAMESPACE).model;
    const modelChanged = stamp !== undefined && embedModel !== "" && stamp !== embedModel;
    let rebuilt = false;
    if (opts.rebuild || modelChanged) {
      vectorService.clear("project", NAMESPACE);
      manifest.clear();
      rebuilt = true;
    }

    let indexedFiles = 0;
    let indexedChunks = 0;
    let skipped = 0;
    const present = new Set<string>();

    for (let i = 0; i < files.length; i++) {
      const rel = files[i]!;
      present.add(rel);
      let content: string;
      try {
        content = await readFile(join(projectDir, rel), "utf8");
      } catch {
        continue; // vanished/unreadable mid-run
      }
      const hash = sha256(content);
      const prev = manifest.get(rel);
      if (prev && prev.hash === hash) {
        skipped++;
        continue;
      }
      const chunks = chunkFile(rel, content);
      if (prev) vectorService.remove("project", NAMESPACE, chunkIds(rel, prev.chunkCount));
      await vectorService.index("project", NAMESPACE, chunks);
      manifest.set(rel, { hash, chunkCount: chunks.length });
      indexedFiles++;
      indexedChunks += chunks.length;
      opts.onProgress?.({ phase: "embed", done: i + 1, total: files.length });
    }

    // Deletions: manifest paths no longer present in the working tree.
    let removed = 0;
    for (const path of manifest.allPaths()) {
      if (present.has(path)) continue;
      const entry = manifest.get(path)!;
      vectorService.remove("project", NAMESPACE, chunkIds(path, entry.chunkCount));
      manifest.delete(path);
      removed++;
    }

    return {
      indexedFiles,
      indexedChunks,
      skipped,
      removed,
      elapsedMs: Date.now() - startedAt,
      rebuilt,
    };
  }
}
