import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "../lib/db";
import { CleetusError } from "../lib/errors";
import { topK } from "./cosine";
import { decodeVector, encodeVector } from "./serialize";
import type { NamespaceStats, VectorHit, VectorRecord } from "./types";

interface VectorRow {
  id: string;
  text: string;
  metadata: string | null;
  embedding: Uint8Array;
}

export class VectorStore {
  private db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        namespace TEXT NOT NULL,
        id        TEXT NOT NULL,
        text      TEXT NOT NULL,
        metadata  TEXT,
        embedding BLOB NOT NULL,
        ts        INTEGER NOT NULL,
        PRIMARY KEY (namespace, id)
      );
      CREATE INDEX IF NOT EXISTS vectors_ns ON vectors(namespace);
      CREATE TABLE IF NOT EXISTS namespaces (
        namespace TEXT PRIMARY KEY,
        model     TEXT NOT NULL,
        dim       INTEGER NOT NULL
      );
    `);
  }

  private stamp(namespace: string): { model: string; dim: number } | undefined {
    return (
      this.db
        .query<{ model: string; dim: number }, [string]>(
          "SELECT model, dim FROM namespaces WHERE namespace = ?",
        )
        .get(namespace) ?? undefined
    );
  }

  private assertModel(namespace: string, model: string, dim: number): void {
    const s = this.stamp(namespace);
    if (s && (s.model !== model || s.dim !== dim)) {
      throw new CleetusError(
        "EMBEDDING_MODEL_MISMATCH",
        `namespace '${namespace}' was built with ${s.model} (dim ${s.dim}); ` +
          `config now says ${model} (dim ${dim}) — re-index to continue`,
      );
    }
  }

  upsert(
    namespace: string,
    records: VectorRecord[],
    embeddings: Float32Array[],
    model: string,
  ): void {
    if (records.length !== embeddings.length) {
      throw new CleetusError(
        "INTERNAL",
        `upsert: ${records.length} records but ${embeddings.length} embeddings`,
      );
    }
    if (records.length === 0) return;
    const dim = embeddings[0]!.length;
    this.assertModel(namespace, model, dim);

    const insertVec = this.db.query(
      `INSERT INTO vectors (namespace, id, text, metadata, embedding, ts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, id) DO UPDATE SET
         text = excluded.text, metadata = excluded.metadata,
         embedding = excluded.embedding, ts = excluded.ts`,
    );
    const upsertNs = this.db.query(
      `INSERT INTO namespaces (namespace, model, dim) VALUES (?, ?, ?)
       ON CONFLICT(namespace) DO NOTHING`,
    );
    const now = Date.now();
    const tx = this.db.transaction(() => {
      upsertNs.run(namespace, model, dim);
      for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        const e = embeddings[i]!;
        if (e.length !== dim) {
          throw new CleetusError("INTERNAL", `upsert: inconsistent embedding dim at index ${i}`);
        }
        insertVec.run(
          namespace,
          r.id,
          r.text,
          r.metadata === undefined ? null : JSON.stringify(r.metadata),
          encodeVector(e),
          now,
        );
      }
    });
    tx();
  }

  query(namespace: string, queryEmbedding: Float32Array, k: number, model: string): VectorHit[] {
    this.assertModel(namespace, model, queryEmbedding.length);
    const rows = this.db
      .query<VectorRow, [string]>(
        "SELECT id, text, metadata, embedding FROM vectors WHERE namespace = ?",
      )
      .all(namespace);
    const candidates = rows.map((row) => ({ item: row, embedding: decodeVector(row.embedding) }));
    return topK(queryEmbedding, candidates, k).map(({ item, score }) => ({
      id: item.id,
      text: item.text,
      metadata: item.metadata === null ? undefined : JSON.parse(item.metadata),
      score,
    }));
  }

  remove(namespace: string, ids: string[]): void {
    const stmt = this.db.query("DELETE FROM vectors WHERE namespace = ? AND id = ?");
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(namespace, id);
    });
    tx();
  }

  clear(namespace: string): void {
    this.db.run("DELETE FROM vectors WHERE namespace = ?", [namespace]);
    this.db.run("DELETE FROM namespaces WHERE namespace = ?", [namespace]);
  }

  stats(namespace: string): NamespaceStats {
    const count =
      this.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM vectors WHERE namespace = ?")
        .get(namespace)?.n ?? 0;
    const s = this.stamp(namespace);
    return { count, model: s?.model, dim: s?.dim };
  }

  close(): void {
    this.db.close();
  }
}
