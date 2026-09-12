import type { ExecOptions, ExecResult } from "./types";

/**
 * After a process exits, how long to keep draining its pipes before giving up. A
 * normal exit drains near-instantly (this bound is never hit); the bound only caps
 * the pathological case where a backgrounded grandchild inherits the pipe and holds
 * it open, which would otherwise hang the caller indefinitely.
 */
const POST_EXIT_DRAIN_GRACE_MS = 2000;

/** After the SIGKILL sweep, how long to keep polling the group for actual death. */
const KILL_VERIFY_WINDOW_MS = 500;
/** Poll interval while verifying the group died (also the re-SIGKILL cadence). */
const KILL_VERIFY_INTERVAL_MS = 50;

/** True if the pid/pgid is still alive. `process.kill(t, 0)` delivers no signal — it only
 *  probes existence: ESRCH means gone; any other outcome (delivered, or EPERM) means alive. */
function defaultIsAlive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export interface VerifyDeps {
  isAlive?: (target: number) => boolean;
  kill?: (signal: NodeJS.Signals) => void;
  windowMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Confirm the killed process group is actually dead, re-sending SIGKILL each interval while
 * anything lingers. Probes the group (negative leaderPid); if the group probe ESRCHes on the
 * first try — detach never took, so there is no group — it falls back to probing the single
 * leader pid. (Post-exit that child is already reaped, so this fallback normally reports
 * nothing; orphaned grandchildren are unobservable without a process group. That is the
 * inherent limit of a non-detached spawn — this path only guarantees we never throw and
 * report the pid in the rare case it is somehow still alive.) Returns surviving pids.
 */
export async function verifyGroupDead(leaderPid: number, deps: VerifyDeps = {}): Promise<number[]> {
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const kill = deps.kill ?? (() => {});
  const windowMs = deps.windowMs ?? KILL_VERIFY_WINDOW_MS;
  const intervalMs = deps.intervalMs ?? KILL_VERIFY_INTERVAL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Prefer the group handle; fall back to the lone leader pid if no group exists.
  const target = isAlive(-leaderPid) ? -leaderPid : leaderPid;
  if (!isAlive(target)) return [];
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (!isAlive(target)) return [];
    kill("SIGKILL");
    await sleep(intervalMs);
  }
  return isAlive(target) ? [leaderPid] : [];
}

/** Drains a ReadableStream into a string in the background, with two finishers. */
function makeStreamCollector(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const drainLoop = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } catch {
      // reader was cancelled, or the stream errored — accept whatever was collected.
    }
  })();
  const collected = () => Buffer.concat(chunks).toString();

  return {
    /** Stop reading and return whatever was buffered. Used after a KILL (avoids a Bun
     * v1.3.12 bug where awaiting a full drain hangs ~10s post-kill). */
    cancelAndCollect: async (): Promise<string> => {
      await reader.cancel().catch(() => {});
      await drainLoop;
      return collected();
    },
    /** Drain to natural EOF, but if the stream stays open past graceMs (e.g. a
     * grandchild inherited the pipe), cancel and return what we have. Used after a
     * NORMAL exit so a misbehaving command can't hang the caller post-exit. */
    finishWithGrace: async (graceMs: number): Promise<string> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const graced = new Promise<boolean>((res) => {
        timer = setTimeout(() => res(false), graceMs);
      });
      const drainedFully = await Promise.race([drainLoop.then(() => true), graced]);
      if (timer) clearTimeout(timer);
      if (drainedFully) return collected();
      await reader.cancel().catch(() => {});
      await drainLoop;
      return collected();
    },
  };
}

/**
 * Spawn an argv, enforce timeout/abort by killing the process, and collect output.
 * `cancelled` (deliberate abort) supersedes `timedOut`: the two are never both true.
 */
export async function spawnCollect(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdin: opts.stdin != null ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Put the command in its own process group (`detached` → pgid === proc.pid) so we can
    // kill the WHOLE subtree, not just the direct child. A dev-server command like
    // `bun tauri dev` forks node → vite → the app binary; signalling only the top child
    // orphans the rest, which keep holding the dev-server port. See killTree.
    detached: true,
  });
  let timedOut = false;
  let cancelled = false;
  // Signal the entire process group (negative pid). Falls back to the direct child if the
  // group is already gone (ESRCH) or detach somehow didn't take — never throws.
  const killTree = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      try {
        proc.kill();
      } catch {
        // process already reaped — nothing to signal.
      }
    }
  };
  const onTimeout = () => {
    timedOut = true;
    killTree("SIGTERM");
  };
  const onCancel = () => {
    cancelled = true;
    killTree("SIGTERM");
  };
  const timer = opts.timeoutMs != null ? setTimeout(onTimeout, opts.timeoutMs) : null;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
  };
  // Clear the timeout the moment the process exits, so a normal exit that finishes
  // near the deadline can't trip `timedOut` after the fact.
  proc.exited.then(clearTimer, clearTimer);
  if (opts.signal.aborted) onCancel();
  else opts.signal.addEventListener("abort", onCancel, { once: true });

  const stdoutCollector = makeStreamCollector(proc.stdout as ReadableStream<Uint8Array>);
  const stderrCollector = makeStreamCollector(proc.stderr as ReadableStream<Uint8Array>);

  try {
    const exitCode = await proc.exited;
    const killed = timedOut || cancelled;
    // The SIGTERM above lets well-behaved processes exit; once the top of the tree is
    // gone, SIGKILL the group to reap any straggler (a dev server / build tool that traps
    // or is slow to handle SIGTERM). Harmless if the group is already empty (ESRCH).
    if (killed) killTree("SIGKILL");
    const collect = (c: ReturnType<typeof makeStreamCollector>) =>
      killed ? c.cancelAndCollect() : c.finishWithGrace(POST_EXIT_DRAIN_GRACE_MS);
    const [stdout, stderr] = await Promise.all([
      collect(stdoutCollector),
      collect(stderrCollector),
    ]);
    // After a kill, confirm the whole group actually died (re-SIGKILL within a bounded
    // window) instead of assuming it. A lingering child becomes a surfaced survivor.
    const survivors = killed ? await verifyGroupDead(proc.pid, { kill: killTree }) : [];
    // Abort supersedes a coincidental timeout: never report both.
    if (cancelled) timedOut = false;
    const result: ExecResult = { stdout, stderr, exitCode, timedOut, cancelled };
    if (survivors.length) result.survivors = survivors;
    return result;
  } finally {
    clearTimer();
    opts.signal.removeEventListener("abort", onCancel);
  }
}
