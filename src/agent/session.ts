import type { Database } from "bun:sqlite";
import { ulid } from "ulid";

export interface Session {
  id: string;
  createdAt: number;
  provider: string;
  model: string;
  title?: string;
}

export interface CreateSessionInput {
  provider: string;
  model: string;
  title?: string;
  id?: string;
}

export class SessionStore {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        title TEXT
      );
    `);
  }

  create(input: CreateSessionInput): Session {
    const session: Session = { ...input, id: input.id ?? ulid(), createdAt: Date.now() };
    this.db.run(
      "INSERT INTO sessions (id, created_at, provider, model, title) VALUES (?, ?, ?, ?, ?)",
      [session.id, session.createdAt, session.provider, session.model, session.title ?? null],
    );
    return session;
  }

  /** Update a session's provider/model — e.g. after the user switches model mid-session,
   * so the stored record reflects what's actually running, not the startup default. */
  updateModel(id: string, provider: string, model: string): void {
    this.db.run("UPDATE sessions SET provider = ?, model = ? WHERE id = ?", [provider, model, id]);
  }

  get(id: string): Session | undefined {
    const row = this.db
      .query<
        { id: string; created_at: number; provider: string; model: string; title: string | null },
        [string]
      >("SELECT id, created_at, provider, model, title FROM sessions WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      createdAt: row.created_at,
      provider: row.provider,
      model: row.model,
      title: row.title ?? undefined,
    };
  }

  list(): Session[] {
    const rows = this.db
      .query<
        { id: string; created_at: number; provider: string; model: string; title: string | null },
        []
      >("SELECT id, created_at, provider, model, title FROM sessions ORDER BY created_at DESC")
      .all();
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      provider: r.provider,
      model: r.model,
      title: r.title ?? undefined,
    }));
  }
}
