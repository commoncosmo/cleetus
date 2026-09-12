import type { TodoItem } from "../tools/types";

export interface FileSnapshot {
  /** Absolute path (matches result.diff.path, which is already resolved). */
  path: string;
  /** Pre-turn content (result.diff.before). Empty string for a created file. */
  before: string;
  /** True when this file did not exist before the turn → rewind deletes it. */
  created: boolean;
}

export interface Checkpoint {
  /** Monotonic, session-stable turn index. Drives `/rewind N` and the picker label. */
  turnNumber: number;
  /** The turn's user message — the picker label. */
  userInput: string;
  /** Model-facing history length BEFORE this turn's user message was appended. */
  historyLength: number;
  /** Creation time (ms). Drives the picker's relative-age label. */
  ts: number;
  /** First-touch-per-path snapshots captured during the turn. Empty for no-edit turns. */
  files: Map<string, FileSnapshot>;
  /** Working todo list as of turn start; restored on rewind. Undefined when the
   *  session had no working list at that point. */
  todos?: TodoItem[];
}

/** A single file operation that undoes part of a turn. Discriminated by `action`
 *  so `content` is required for a write and absent for a delete. */
export type RestorationStep =
  | { path: string; action: "write"; content: string }
  | { path: string; action: "delete" };

export interface RewindOutcome {
  revertedTurns: number;
  filesRestored: number;
  filesDeleted: number;
  /** Model-facing history length to truncate to. */
  historyLength: number;
  /** User message of the target turn (for the marker / summary). */
  userInput: string;
  /** Working todo list to restore; the state that existed before the rewound turn(s). */
  todos?: TodoItem[];
  /** True when the target checkpoint had no file snapshot (git snapshot had failed),
   *  so the conversation/todos were restored but the files were not. */
  filesRestoreSkipped?: boolean;
}

/** Minimal seam the runtime needs from the checkpoint layer. `begin` may be async
 *  (the git-backed store does I/O); the runtime awaits it. */
export interface CheckpointRecorder {
  /** Open a checkpoint for a turn. Called at turn start, before the user message is
   *  appended. `sessionId` scopes both durable and in-memory checkpoints. */
  begin(
    sessionId: string,
    userInput: string,
    historyLength: number,
    todos?: TodoItem[],
  ): void | Promise<void>;
  /** Record the pre-turn state of a touched file. First touch per path per turn wins.
   *  No-op for whole-tree (git-backed) snapshots. */
  recordFile(path: string, before: string, created: boolean): void;
}

/** A picker/`/rewind` row. Both stores produce these from their list(). */
export interface CheckpointSummary {
  turnNumber: number;
  userInput: string;
  ts: number;
}

/** The full store the bin drives: recorder + listing + rewind. */
export interface CheckpointBackend extends CheckpointRecorder {
  /** Live checkpoints for the session, oldest → newest. */
  list(sessionId: string): CheckpointSummary[];
  /** Revert the target turn AND every later turn. Returns null when the turn is unknown. */
  rewindTo(sessionId: string, turnNumber: number): Promise<RewindOutcome | null>;
}
