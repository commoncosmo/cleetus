import { CleetusError } from "../lib/errors";
import type { Embedder } from "./embedder";
import { VectorStore } from "./store";
import type { NamespaceStats, Scope, VectorHit, VectorRecord } from "./types";

export interface VectorServiceOptions {
  projectDbPath: string;
  globalDbPath: string;
  /** null when no `embeddings` config is present — service reports `enabled === false`. */
  embedder: Embedder | null;
}

export class VectorService {
  private readonly project: VectorStore;
  private readonly global: VectorStore;
  private readonly embedder: Embedder | null;

  constructor(opts: VectorServiceOptions) {
    this.project = new VectorStore(opts.projectDbPath);
    this.global = new VectorStore(opts.globalDbPath);
    this.embedder = opts.embedder;
  }

  get enabled(): boolean {
    return this.embedder !== null;
  }

  private store(scope: Scope): VectorStore {
    return scope === "project" ? this.project : this.global;
  }

  private requireEmbedder(): Embedder {
    if (!this.embedder) {
      throw new CleetusError(
        "EMBEDDINGS_DISABLED",
        "embeddings are not configured — add an `embeddings` block to config.yaml",
      );
    }
    return this.embedder;
  }

  async index(scope: Scope, namespace: string, records: VectorRecord[]): Promise<void> {
    const embedder = this.requireEmbedder();
    if (records.length === 0) return;
    const embeddings = await embedder.embedBatch(records.map((r) => r.text));
    this.store(scope).upsert(namespace, records, embeddings, embedder.model);
  }

  async search(scope: Scope, namespace: string, query: string, k: number): Promise<VectorHit[]> {
    const embedder = this.requireEmbedder();
    const queryVec = await embedder.embed(query);
    return this.store(scope).query(namespace, queryVec, k, embedder.model);
  }

  remove(scope: Scope, namespace: string, ids: string[]): void {
    this.store(scope).remove(namespace, ids);
  }

  clear(scope: Scope, namespace: string): void {
    this.store(scope).clear(namespace);
  }

  stats(scope: Scope, namespace: string): NamespaceStats {
    return this.store(scope).stats(namespace);
  }

  close(): void {
    this.project.close();
    this.global.close();
  }
}
