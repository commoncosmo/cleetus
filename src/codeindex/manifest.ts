import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "../lib/db";
import type { ManifestEntry } from "./types";

export class Manifest {
  private db: Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path        TEXT PRIMARY KEY,
        hash        TEXT NOT NULL,
        chunk_count INTEGER NOT NULL
      );
    `);
  }

  get(path: string): ManifestEntry | undefined {
    const row = this.db
      .query<{ hash: string; chunk_count: number }, [string]>(
        "SELECT hash, chunk_count FROM files WHERE path = ?",
      )
      .get(path);
    return row ? { hash: row.hash, chunkCount: row.chunk_count } : undefined;
  }

  set(path: string, entry: ManifestEntry): void {
    this.db.run(
      `INSERT INTO files (path, hash, chunk_count) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, chunk_count = excluded.chunk_count`,
      [path, entry.hash, entry.chunkCount],
    );
  }

  delete(path: string): void {
    this.db.run("DELETE FROM files WHERE path = ?", [path]);
  }

  allPaths(): string[] {
    return this.db
      .query<{ path: string }, []>("SELECT path FROM files ORDER BY path")
      .all()
      .map((r) => r.path);
  }

  clear(): void {
    this.db.run("DELETE FROM files");
  }

  close(): void {
    this.db.close();
  }
}
