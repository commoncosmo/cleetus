import type { TodoItem } from "../tools/types";
import type { CheckpointMetaStore } from "./meta-store";
import type { ShadowRepo } from "./shadow-repo";
import type { CheckpointBackend, CheckpointSummary, RewindOutcome } from "./types";

/**
 * Durable, git-backed checkpoint store. Active when the project is a git repo.
 * Whole-tree snapshots live in the shadow repo; per-turn metadata lives in sqlite,
 * so `/rewind` survives a restart. Stateless by sessionId.
 */
export class GitCheckpointStore implements CheckpointBackend {
  constructor(private readonly deps: { shadow: ShadowRepo; meta: CheckpointMetaStore }) {}

  async begin(
    sessionId: string,
    userInput: string,
    historyLength: number,
    todos?: TodoItem[],
  ): Promise<void> {
    // Snapshot the PRE-turn tree (begin runs before any edit). null on failure →
    // a conversation-only checkpoint that still rewinds history + todos.
    const commitSha = await this.deps.shadow.snapshot();
    const turnNumber = this.deps.meta.nextTurnNumber(sessionId);
    this.deps.meta.add({
      sessionId,
      turnNumber,
      commitSha,
      historyLength,
      userInput,
      todos: todos ? [...todos] : undefined,
      ts: Date.now(),
    });
  }

  recordFile(_path: string, _before: string, _created: boolean): void {
    // Whole-tree state is captured at begin; nothing to do per file.
  }

  list(sessionId: string): CheckpointSummary[] {
    return this.deps.meta.list(sessionId);
  }

  async rewindTo(sessionId: string, turnNumber: number): Promise<RewindOutcome | null> {
    const target = this.deps.meta.get(sessionId, turnNumber);
    if (!target) return null;

    const revertedTurns = this.deps.meta.countFrom(sessionId, turnNumber);
    let filesRestored = 0;
    let filesDeleted = 0;
    let filesRestoreSkipped = false;

    if (target.commitSha) {
      const counts = await this.deps.shadow.restore(target.commitSha);
      filesRestored = counts.filesRestored;
      filesDeleted = counts.filesDeleted;
    } else {
      filesRestoreSkipped = true;
    }

    // Drop the target and later rows only after a successful restore, so a thrown
    // restore() leaves the metadata intact for a safe retry.
    this.deps.meta.truncateFrom(sessionId, turnNumber);

    return {
      revertedTurns,
      filesRestored,
      filesDeleted,
      historyLength: target.historyLength,
      userInput: target.userInput,
      todos: target.todos,
      filesRestoreSkipped,
    };
  }
}
