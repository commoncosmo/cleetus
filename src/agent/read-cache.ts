import type { ReadCache, ReadReconcile } from "../tools/types";

function hash(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

/**
 * Per-session, boundary-aware unchanged-re-read elider (#143, #153). Tracks, per resolved path,
 * the hash of the last-read content, an escalating unchanged-repeat count, and `bodyIndex` — the
 * history index at which the file's last FULL body was sent. `reconcile` elides a re-read to a
 * note only when the content is unchanged AND that body is still in the live window
 * (`bodyIndex >= verbatimStart`); otherwise it returns the full body and re-stamps `bodyIndex`.
 * An edit changes the content → new hash → counter resets, so a re-read after an edit is sent.
 */
export class SessionReadCache implements ReadCache {
  private readonly seen = new Map<string, { hash: string; count: number; bodyIndex: number }>();

  reconcile(
    path: string,
    content: string,
    resultIndex: number,
    verbatimStart: number,
    liveCap: number = Number.POSITIVE_INFINITY,
  ): ReadReconcile {
    const h = hash(content);
    const prev = this.seen.get(path);
    const sameContent = prev !== undefined && prev.hash === h;
    // The prior body is the model's verbatim copy only when it sits at/after verbatimStart —
    // the un-truncated, un-compacted region of the sent tail.
    const inWindow = prev !== undefined && prev.bodyIndex >= verbatimStart;
    // A body over the live cap was head/tail-cut when sent (WS1.2), so the in-window copy is
    // NOT verbatim — re-send rather than pointing the model at lost data.
    const fitsCap = content.length <= liveCap;
    if (sameContent && inWindow && fitsCap) {
      // The model still has the verbatim body → elide. bodyIndex is left pointing at that
      // still-live copy, NOT advanced to this elided (note-only) result.
      prev.count += 1;
      return { content: elisionNote(path, prev.count, content), elided: true };
    }
    // First read, content changed, or the prior body fell outside the verbatim region (folded
    // into the digest OR truncated by slimDeepHistory) → send the full body and stamp its
    // position. The model now has it fresh, so the unchanged-repeat escalation restarts at 1.
    this.seen.set(path, { hash: h, count: 1, bodyIndex: resultIndex });
    return { content, elided: false };
  }
}

function elisionNote(path: string, count: number, content: string): string {
  const lines = content.length === 0 ? 0 : content.split("\n").length;
  return count >= 3
    ? `[STOP: you have re-read ${path} ${count}× with no change — its ${lines} lines are already in your context above. Do NOT read it again; use what you have and continue.]`
    : `[Note: ${path} is unchanged since you last read it — its ${lines} lines are already in your context above and are not being resent. Rely on the copy you already have.]`;
}
