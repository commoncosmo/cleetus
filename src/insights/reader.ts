import { existsSync } from "node:fs";
import type { EventSource } from "../events/log";
import type { Event } from "../events/types";
import { openDatabase } from "../lib/db";

/**
 * Read-only EventSource over a sessions.db file. Returns null if the file is absent.
 * The underlying Database handle is intentionally not exposed/closed: this is used by the
 * short-lived `cleetus analyze` process, where the OS reclaims the fd on exit. Do not reuse
 * in a long-lived context without adding a close path.
 */
export function openEventSource(dbPath: string): EventSource | null {
  if (!existsSync(dbPath)) return null;
  const db = openDatabase(dbPath, { readonly: true });
  return {
    listSessions(): string[] {
      return db
        .query<{ session_id: string }, []>(
          "SELECT session_id FROM events GROUP BY session_id ORDER BY MIN(rowid)",
        )
        .all()
        .map((r) => r.session_id);
    },
    query(sessionId: string): Event[] {
      const rows = db
        .query<
          { id: string; session_id: string; ts: number; type: string; payload: string },
          [string]
        >(
          "SELECT id, session_id, ts, type, payload FROM events WHERE session_id = ? ORDER BY rowid ASC",
        )
        .all(sessionId);
      return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        ts: r.ts,
        type: r.type as Event["type"],
        payload: JSON.parse(r.payload),
      }));
    },
  };
}
