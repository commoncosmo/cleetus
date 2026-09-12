import type { Database } from "bun:sqlite";
import type { TodoItem } from "../tools/types";
import type { CheckpointSummary } from "./types";

/** One persisted checkpoint row. `commitSha` is null when the snapshot failed. */
export interface CheckpointRecord {
  sessionId: string;
  turnNumber: number;
  commitSha: string | null;
  historyLength: number;
  userInput: string;
  todos?: TodoItem[];
  ts: number;
}

/**
 * Durable per-turn checkpoint metadata, one row per (session_id, turn_number).
 * Survives restart so `/rewind` works after `--resume`. Mirrors SessionHistoryStore's
 * shape; shares the same sessions.db.
 */
export class CheckpointMetaStore {
  constructor(
    private db: Database,
    private maxCheckpoints: number,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        commit_sha TEXT,
        history_length INTEGER NOT NULL,
        user_input TEXT NOT NULL,
        todos TEXT,
        ts INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn_number)
      );
    `);
  }

  /** The next turn number for the session: max(existing) + 1, or 0 when none. */
  nextTurnNumber(sessionId: string): number {
    const row = this.db
      .query<{ max: number | null }, [string]>(
        "SELECT MAX(turn_number) AS max FROM checkpoints WHERE session_id = ?",
      )
      .get(sessionId);
    return (row?.max ?? -1) + 1;
  }

  add(rec: CheckpointRecord): void {
    this.db.run(
      `INSERT INTO checkpoints
         (session_id, turn_number, commit_sha, history_length, user_input, todos, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.sessionId,
        rec.turnNumber,
        rec.commitSha,
        rec.historyLength,
        rec.userInput,
        rec.todos ? JSON.stringify(rec.todos) : null,
        rec.ts,
      ],
    );
    // Enforce the per-session cap: keep only the newest N rows.
    this.db.run(
      `DELETE FROM checkpoints
        WHERE session_id = ?
          AND turn_number NOT IN (
            SELECT turn_number FROM checkpoints
             WHERE session_id = ? ORDER BY turn_number DESC LIMIT ?
          )`,
      [rec.sessionId, rec.sessionId, this.maxCheckpoints],
    );
  }

  list(sessionId: string): CheckpointSummary[] {
    return this.db
      .query<{ turn_number: number; user_input: string; ts: number }, [string]>(
        "SELECT turn_number, user_input, ts FROM checkpoints WHERE session_id = ? ORDER BY turn_number ASC",
      )
      .all(sessionId)
      .map((r) => ({ turnNumber: r.turn_number, userInput: r.user_input, ts: r.ts }));
  }

  get(sessionId: string, turnNumber: number): CheckpointRecord | undefined {
    const r = this.db
      .query<
        {
          commit_sha: string | null;
          history_length: number;
          user_input: string;
          todos: string | null;
          ts: number;
        },
        [string, number]
      >(
        "SELECT commit_sha, history_length, user_input, todos, ts FROM checkpoints WHERE session_id = ? AND turn_number = ?",
      )
      .get(sessionId, turnNumber);
    if (!r) return undefined;
    return {
      sessionId,
      turnNumber,
      commitSha: r.commit_sha,
      historyLength: r.history_length,
      userInput: r.user_input,
      todos: r.todos ? (JSON.parse(r.todos) as TodoItem[]) : undefined,
      ts: r.ts,
    };
  }

  /** Count of rows at turn_number >= turnNumber for the session. */
  countFrom(sessionId: string, turnNumber: number): number {
    const r = this.db
      .query<{ n: number }, [string, number]>(
        "SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ? AND turn_number >= ?",
      )
      .get(sessionId, turnNumber);
    return r?.n ?? 0;
  }

  /** Delete the target turn and every later turn for the session. */
  truncateFrom(sessionId: string, turnNumber: number): void {
    this.db.run("DELETE FROM checkpoints WHERE session_id = ? AND turn_number >= ?", [
      sessionId,
      turnNumber,
    ]);
  }
}
