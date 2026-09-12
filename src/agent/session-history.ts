import type { Database } from "bun:sqlite";
import type { Message } from "../providers/types";
import type { TodoItem } from "../tools/types";

export interface SessionSnapshot {
  messages: Message[];
  todos: TodoItem[];
}

/** Persists the exact conversation snapshot (history + working todos) per session,
 *  so resume/fork can restore it verbatim. One row per session_id (upsert). */
export class SessionHistoryStore {
  constructor(private db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_history (
        session_id TEXT PRIMARY KEY,
        messages TEXT NOT NULL,
        todos TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  save(sessionId: string, messages: Message[], todos: TodoItem[]): void {
    this.db.run(
      `INSERT INTO session_history (session_id, messages, todos, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         messages = excluded.messages,
         todos = excluded.todos,
         updated_at = excluded.updated_at`,
      [sessionId, JSON.stringify(messages), JSON.stringify(todos), Date.now()],
    );
  }

  load(sessionId: string): SessionSnapshot | undefined {
    const row = this.db
      .query<{ messages: string; todos: string }, [string]>(
        "SELECT messages, todos FROM session_history WHERE session_id = ?",
      )
      .get(sessionId);
    if (!row) return undefined;
    return { messages: JSON.parse(row.messages), todos: JSON.parse(row.todos) };
  }

  /** Cheap presence check — no deserialization. */
  exists(sessionId: string): boolean {
    const row = this.db
      .query<{ one: number }, [string]>("SELECT 1 AS one FROM session_history WHERE session_id = ?")
      .get(sessionId);
    return row != null;
  }

  copy(fromId: string, toId: string): void {
    const snap = this.load(fromId);
    if (!snap) return;
    this.save(toId, snap.messages, snap.todos);
  }
}
