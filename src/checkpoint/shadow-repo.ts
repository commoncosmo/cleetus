import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type GitRunContext, type GitRunResult, runGit } from "../git/run";
import type { Sandbox } from "../sandbox/types";

export interface RestoreCounts {
  filesRestored: number;
  filesDeleted: number;
}

/**
 * A hidden git repo at `.cleetus/checkpoints.git` whose work-tree is the project.
 * Snapshots the whole tree per turn and restores it on rewind. The separate GIT_DIR
 * keeps every operation out of the user's real `.git` — their index, branches, and
 * history are never read or written.
 */
export class ShadowRepo {
  private readonly shadowDir: string;
  private initialized = false;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly projectDir: string,
    private readonly mirrorDir?: string,
  ) {
    this.shadowDir = join(projectDir, ".cleetus", "checkpoints.git");
  }

  /** Best-effort copy of the append-only Git object store and moving refs. The primary shadow
   * repo remains project-local for normal /rewind behavior; this mirror survives `rm -rf` of the
   * work tree and can be used for disaster recovery. */
  private async mirror(): Promise<void> {
    if (!this.mirrorDir) return;
    try {
      await mkdir(this.mirrorDir, { recursive: true });
      for (const entry of await readdir(this.shadowDir)) {
        await cp(join(this.shadowDir, entry), join(this.mirrorDir, entry), {
          recursive: true,
          // Loose Git objects are content-addressed and immutable. Skipping objects already in
          // the mirror avoids recopying the full historical object database every turn; refs,
          // HEAD, config, and other small mutable metadata still overwrite their prior values.
          force: entry !== "objects",
          errorOnExist: false,
        });
      }
    } catch {
      // Recovery mirroring is advisory and must never abort a turn.
    }
  }

  private ctx(): GitRunContext {
    // Checkpoint git ops are quick and run between/at turn boundaries; a fresh,
    // never-aborted signal is fine (runGit's 120s timeout guards hangs).
    return { projectDir: this.projectDir, abortSignal: new AbortController().signal };
  }

  private git(argv: string[]): Promise<GitRunResult> {
    return runGit(
      this.sandbox,
      ["--git-dir", this.shadowDir, "--work-tree", this.projectDir, ...argv],
      this.ctx(),
    );
  }

  /** Init the shadow repo once and seed its excludes. Idempotent. */
  async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    const head = Bun.file(join(this.shadowDir, "HEAD"));
    if (!(await head.exists())) {
      // git init --git-dir does not create parent dirs; ensure the shadow path exists.
      await mkdir(this.shadowDir, { recursive: true });
      await this.git(["init", "--quiet"]);
      // Never snapshot the user's real git dir, our own state, or heavy
      // dependency/build/cache dirs (so a rewind can't clobber installed deps even
      // when the project has no .gitignore). The project's own .gitignore is also
      // honored by git on top of these.
      const excludes = [
        ".git/",
        ".cleetus/",
        "node_modules/",
        ".venv/",
        "venv/",
        "__pycache__/",
        "target/",
        "dist/",
        "build/",
        ".next/",
      ];
      await Bun.write(join(this.shadowDir, "info", "exclude"), `${excludes.join("\n")}\n`);
    }
    this.initialized = true;
  }

  /**
   * Commit the current work tree as a checkpoint. Returns the commit SHA, the
   * existing HEAD SHA when the tree is unchanged (dedup), or null on any failure
   * (advisory — the caller records a null-commit checkpoint).
   */
  async snapshot(): Promise<string | null> {
    // Fully advisory: any failure (git error OR fs error from ensureRepo) yields a
    // null-commit checkpoint rather than breaking the turn.
    try {
      await this.ensureRepo();
      if ((await this.git(["add", "-A"])).exitCode !== 0) return null;
      const tree = await this.git(["write-tree"]);
      if (tree.exitCode !== 0) return null;
      const treeSha = tree.stdout.trim();

      const headTree = await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
      if (headTree.exitCode === 0 && headTree.stdout.trim() === treeSha) {
        const head = await this.git(["rev-parse", "HEAD"]);
        if (head.exitCode !== 0) return null;
        await this.mirror();
        return head.stdout.trim();
      }

      const commit = await this.git([
        "-c",
        "user.name=cleetus",
        "-c",
        "user.email=cleetus@local",
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "checkpoint",
      ]);
      if (commit.exitCode !== 0) return null;
      const head = await this.git(["rev-parse", "HEAD"]);
      if (head.exitCode !== 0) return null;
      await this.mirror();
      return head.stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Make the work tree exactly match `sha`: tracked files reset to their snapshotted
   * content, files added since `sha` removed. Files excluded from snapshots (the
   * shadow repo's `info/exclude` — deps/build/cache dirs — plus the project's own
   * `.gitignore`) are never staged and so are left untouched.
   */
  async restore(sha: string): Promise<RestoreCounts> {
    await this.ensureRepo();
    // Stage the actual current state so counts reflect mid-turn edits, not just the
    // last snapshot, then diff it against the target tree.
    await this.git(["add", "-A"]);
    const cur = await this.git(["write-tree"]);
    const counts =
      cur.exitCode === 0
        ? await this.diffCounts(sha, cur.stdout.trim())
        : { filesRestored: 0, filesDeleted: 0 };

    await this.git(["read-tree", sha]);
    await this.git(["checkout-index", "-a", "-f"]);
    await this.git(["clean", "-fd"]);
    return counts;
  }

  /** Counts from `git diff --name-status <target> <current>`: lines added in current
   *  (absent in target) get deleted on rewind; everything else is restored. */
  private async diffCounts(targetSha: string, curTree: string): Promise<RestoreCounts> {
    const d = await this.git(["diff", "--name-status", targetSha, curTree]);
    if (d.exitCode !== 0) return { filesRestored: 0, filesDeleted: 0 };
    let filesRestored = 0;
    let filesDeleted = 0;
    for (const line of d.stdout.split("\n")) {
      if (!line.trim()) continue;
      if (line[0] === "A") filesDeleted++;
      else filesRestored++;
    }
    return { filesRestored, filesDeleted };
  }
}
