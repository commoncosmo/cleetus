import type { TodoItem } from "../tools/types";
import { applyRestoration } from "./apply";
import { resolveRestoration } from "./resolve";
import type { Checkpoint, CheckpointBackend, RewindOutcome } from "./types";

/**
 * Session-scoped, in-memory rings of turn checkpoints backing `/rewind`.
 *
 * The non-git fallback. Each ACP/TUI session receives an independent bounded ring. `recordFile`
 * applies to the most recent `begin`; callers serialize turns before sharing this store.
 *
 * Not concurrency-safe: `rewindTo` (async, does fs I/O) must not overlap a running
 * turn's `begin`/`recordFile` (both sync). In practice this holds because rewind is
 * driven by a slash command, which runs between turns, never during one.
 */
export class CheckpointStore implements CheckpointBackend {
  private readonly sessions = new Map<string, { ring: Checkpoint[]; nextTurn: number }>();
  private current: { sessionId: string; checkpoint: Checkpoint } | null = null;
  private readonly maxCheckpoints: number;

  constructor(maxCheckpoints: number) {
    // Guard a degenerate cap: with 0, begin would evict the checkpoint it just
    // created, leaving `current` dangling and silently dropping its snapshots.
    this.maxCheckpoints = Math.max(1, maxCheckpoints);
  }

  begin(sessionId: string, userInput: string, historyLength: number, todos?: TodoItem[]): void {
    const state = this.state(sessionId);
    const cp: Checkpoint = {
      turnNumber: state.nextTurn++,
      userInput,
      historyLength,
      ts: Date.now(),
      files: new Map(),
      // Snapshot the list, not the live reference, so later turns can't mutate it.
      todos: todos ? [...todos] : undefined,
    };
    state.ring.push(cp);
    this.current = { sessionId, checkpoint: cp };
    if (state.ring.length > this.maxCheckpoints) state.ring.shift();
  }

  recordFile(path: string, before: string, created: boolean): void {
    if (!this.current) return;
    if (this.current.checkpoint.files.has(path)) return; // first touch wins
    this.current.checkpoint.files.set(path, { path, before, created });
  }

  /** Live checkpoints, oldest → newest. */
  list(sessionId: string): Checkpoint[] {
    return [...(this.sessions.get(sessionId)?.ring ?? [])];
  }

  /** Revert the target turn AND every turn after it: restore files, then drop those
   *  checkpoints. Returns null when the turn isn't in the ring (evicted/unknown). */
  async rewindTo(sessionId: string, turnNumber: number): Promise<RewindOutcome | null> {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const idx = state.ring.findIndex((c) => c.turnNumber === turnNumber);
    if (idx === -1) return null;
    const target = state.ring[idx]!;
    const undone = state.ring.slice(idx); // target (itself undone) + everything after
    const steps = resolveRestoration(undone);
    // If applyRestoration throws, the ring is left untouched below, so a retry is safe.
    await applyRestoration(steps);
    const filesDeleted = steps.filter((s) => s.action === "delete").length;
    const filesRestored = steps.length - filesDeleted;
    state.ring = state.ring.slice(0, idx); // drop target and later
    if (this.current?.sessionId === sessionId) this.current = null;
    return {
      revertedTurns: undone.length,
      filesRestored,
      filesDeleted,
      historyLength: target.historyLength,
      userInput: target.userInput,
      todos: target.todos,
    };
  }

  private state(sessionId: string): { ring: Checkpoint[]; nextTurn: number } {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const state = { ring: [], nextTurn: 0 };
    this.sessions.set(sessionId, state);
    return state;
  }
}
