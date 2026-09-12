import type { Database } from "bun:sqlite";
import type { CheckpointConfig } from "../config/types";
import { isGitRepo } from "../git/repo";
import type { Sandbox } from "../sandbox/types";
import { GitCheckpointStore } from "./git-store";
import { CheckpointMetaStore } from "./meta-store";
import { ShadowRepo } from "./shadow-repo";
import { CheckpointStore } from "./store";
import type { CheckpointBackend } from "./types";

export interface CheckpointDeps {
  sandbox: Sandbox;
  projectDir: string;
  db: Database;
  /** External recovery mirror outside the model-writable project tree. */
  mirrorDir?: string;
}

/**
 * Build the checkpoint store, or undefined when disabled. Uses the durable
 * git-backed store in a git repo (snapshots survive restart); otherwise the
 * session-only in-memory ring.
 */
export async function buildCheckpointStore(
  config: CheckpointConfig,
  deps: CheckpointDeps,
): Promise<CheckpointBackend | undefined> {
  if (!config.enabled) return undefined;
  const ctx = { projectDir: deps.projectDir, abortSignal: new AbortController().signal };
  if (await isGitRepo(deps.sandbox, ctx)) {
    return new GitCheckpointStore({
      shadow: new ShadowRepo(deps.sandbox, deps.projectDir, deps.mirrorDir),
      meta: new CheckpointMetaStore(deps.db, config.maxCheckpoints),
    });
  }
  return new CheckpointStore(config.maxCheckpoints);
}
