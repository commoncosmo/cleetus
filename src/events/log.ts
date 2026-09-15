import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";
import { openDatabase } from "../lib/db";
import type { Event, EventInput, EventListener } from "./types";

/** Narrow read-only seam the insights layer depends on. EventLog implements it. */
export interface EventSource {
  listSessions(): string[];
  query(sessionId: string): Event[];
}

export class EventLog {
  private db: Database;
  private mirrorDb?: Database;
  private listeners: Map<string, Set<EventListener>> = new Map();
  /** Set once a write fails; suppresses the per-event error flood until a write succeeds again.
   *  A working dir deleted under the open handle (e.g. `rm -rf .cleetus` mid-session) turns every
   *  append into SQLITE_IOERR — reasoning streams hundreds of events, so without this one lost DB
   *  spams the console unboundedly. Reset on the next successful write so a distinct later failure
   *  is still reported. */
  private writeFailing = false;
  /** Mirrors `writeFailing` for the external recovery database. */
  private mirrorWriteFailing = false;

  constructor(dbPath: string, opts?: { mirrorPath?: string }) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = openDatabase(dbPath, { create: true });
    this.initialize(this.db);
    if (opts?.mirrorPath && opts.mirrorPath !== dbPath && dbPath !== ":memory:") {
      try {
        mkdirSync(dirname(opts.mirrorPath), { recursive: true, mode: 0o700 });
        this.mirrorDb = openDatabase(opts.mirrorPath, { create: true });
        this.initialize(this.mirrorDb);
      } catch (e) {
        this.mirrorDb?.close();
        this.mirrorDb = undefined;
        console.error(
          `[cleetus] recovery event log unavailable; continuing with the project log: ${(e as Error).message}`,
        );
      }
    }
  }

  private initialize(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);
    `);
  }

  private insert(db: Database, event: Event): void {
    db.run("INSERT INTO events (id, session_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)", [
      event.id,
      event.sessionId,
      event.ts,
      event.type,
      JSON.stringify(event.payload),
    ]);
  }

  append(input: EventInput): Event {
    const event: Event = {
      ...input,
      id: ulid(),
      ts: Date.now(),
    };
    // Persistence is best-effort: the event log is a side-channel (transcript/forensics/resume),
    // not turn-critical. A write failure (e.g. a transient SQLITE_BUSY that outlasts busy_timeout)
    // must NOT abort the model turn — losing one event beats killing the run. Listeners (the live
    // TUI) fire regardless, so the in-session view stays consistent even if the row didn't persist.
    try {
      this.insert(this.db, event);
      this.writeFailing = false; // a success ends the current failure episode
    } catch (e) {
      // Report the first failure of an episode once, then go quiet — see `writeFailing`.
      if (!this.writeFailing) {
        this.writeFailing = true;
        console.error(`[cleetus] event log write failed (${event.type}): ${(e as Error).message}`);
        console.error(
          "[cleetus] event log persistence lost (working dir removed?) — continuing this session " +
            "without transcript; further write errors suppressed.",
        );
      }
    }
    // The recovery mirror is deliberately independent: a deleted project DB must not prevent the
    // exact destructive tool call and permission trail from surviving outside the work tree.
    try {
      if (this.mirrorDb) {
        this.insert(this.mirrorDb, event);
        this.mirrorWriteFailing = false;
      }
    } catch (e) {
      if (!this.mirrorWriteFailing) {
        this.mirrorWriteFailing = true;
        console.error(
          `[cleetus] recovery event log write failed (${event.type}): ${(e as Error).message}`,
        );
        console.error("[cleetus] further recovery event log write errors suppressed.");
      }
    }
    const subs = this.listeners.get(event.sessionId);
    if (subs) for (const fn of subs) fn(event);
    return event;
  }

  query(sessionId: string): Event[] {
    const rows = this.db
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
  }

  listSessions(): string[] {
    return this.db
      .query<{ session_id: string }, []>(
        "SELECT session_id FROM events GROUP BY session_id ORDER BY MIN(rowid)",
      )
      .all()
      .map((r) => r.session_id);
  }

  subscribe(sessionId: string, listener: EventListener): () => void {
    let subs = this.listeners.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.listeners.set(sessionId, subs);
    }
    subs.add(listener);
    return () => {
      const s = this.listeners.get(sessionId);
      s?.delete(listener);
      if (s && s.size === 0) this.listeners.delete(sessionId);
    };
  }

  close(): void {
    this.db.close();
    this.mirrorDb?.close();
  }
}
