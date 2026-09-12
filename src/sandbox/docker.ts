import { randomUUID } from "node:crypto";
import { buildExecArgs, buildRunArgs } from "./docker-args";
import { parsePids, sentinelMarker } from "./docker-teardown";
import { spawnCollect } from "./spawn";
import { type ExecOptions, type ExecResult, type Sandbox, SandboxUnavailableError } from "./types";

/** Grace between the in-container SIGTERM and SIGKILL during teardown. */
const DOCKER_TEARDOWN_GRACE_MS = 300;
/** Hard cap on each best-effort teardown sub-command. */
const DOCKER_TEARDOWN_CMD_TIMEOUT_MS = 3000;

/** Runs commands in a session-scoped Docker container with the project dir bind-mounted. */
export class DockerSandbox implements Sandbox {
  private containerId: string | null = null;
  private startError: string | null = null;
  private startPromise: Promise<string> | null = null;

  constructor(
    readonly image: string,
    private readonly projectDir: string,
    private readonly network = true,
    private readonly dockerBin = "docker",
  ) {}

  /** Lazily start the container on first use; cache success or the failure reason.
   *  The start promise is memoized so concurrent first-exec calls share one container. */
  private async ensureStarted(): Promise<string> {
    if (this.containerId) return this.containerId;
    if (this.startError) throw new SandboxUnavailableError(this.startError);
    if (!this.startPromise) this.startPromise = this.start();
    return this.startPromise;
  }

  private async start(): Promise<string> {
    try {
      const proc = Bun.spawn(
        [this.dockerBin, ...buildRunArgs(this.image, this.projectDir, this.network)],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (code !== 0) {
        this.startError = (err || out).trim() || `docker run exited ${code}`;
        console.error(`[cleetus] sandbox unavailable: ${this.startError}`);
        throw new SandboxUnavailableError(this.startError);
      }
      this.containerId = out.trim();
      return this.containerId;
    } catch (e) {
      if (e instanceof SandboxUnavailableError) throw e;
      // docker binary missing / spawn failed
      this.startError = (e as Error).message;
      console.error(`[cleetus] sandbox unavailable: ${this.startError}`);
      throw new SandboxUnavailableError(this.startError);
    }
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const id = await this.ensureStarted();
    const cwd = opts.cwd ?? this.projectDir;
    // Tag the in-container workload with a unique marker (see docker-teardown.ts) so that if
    // it times out/aborts we can find its setsid group leader and kill the whole tree —
    // killing the host-side `docker exec` client alone does NOT stop the in-container process.
    const sentinel = randomUUID();
    const result = await spawnCollect(
      [this.dockerBin, ...buildExecArgs(id, command, cwd, opts.stdin != null, sentinel)],
      { ...opts, cwd: undefined },
    );
    // Strip any host-side survivors — they are never meaningful for Docker (the host sees the
    // `docker exec` client process, not the in-container workload).
    const { survivors: _hostSurvivors, ...rest } = result;
    if (result.timedOut || result.cancelled) {
      const survivors = await this.teardownInContainer(id, sentinel);
      return survivors.length ? { ...rest, survivors } : rest;
    }
    return rest;
  }

  /** Best-effort: find the timed-out workload's setsid group leader by its marker and
   *  SIGTERM→grace→SIGKILL the whole group. Returns any in-container PIDs still alive after.
   *  Never throws — a missing `pgrep`/`setsid` (minimal image) degrades to a no-op. */
  private async teardownInContainer(id: string, sentinel: string): Promise<number[]> {
    const marker = sentinelMarker(sentinel);
    const findLeaders = async (): Promise<number[]> =>
      parsePids((await this.dockerExecOnce(["exec", id, "pgrep", "-f", marker])).stdout);

    const leaders = await findLeaders();
    if (leaders.length === 0) return [];
    const groupArgs = leaders.map((p) => `-${p}`).join(" "); // negative pid == its process group

    // Route the group-kill through `bash` (guaranteed present — the workload launched under
    // `bash -c`), whose builtin `kill` reliably accepts the negative-pid group form; busybox
    // ash's does not.
    await this.dockerExecOnce(["exec", id, "bash", "-c", `kill -TERM ${groupArgs} 2>/dev/null`]);
    await new Promise<void>((r) => setTimeout(r, DOCKER_TEARDOWN_GRACE_MS));
    await this.dockerExecOnce(["exec", id, "bash", "-c", `kill -KILL ${groupArgs} 2>/dev/null`]);
    return findLeaders();
  }

  /** One-shot host-side `docker <args>` with a hard timeout; captures stdout, ignores
   *  stderr, and never throws (teardown is best-effort). */
  private async dockerExecOnce(args: string[]): Promise<{ stdout: string }> {
    try {
      const proc = Bun.spawn([this.dockerBin, ...args], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }, DOCKER_TEARDOWN_CMD_TIMEOUT_MS);
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      clearTimeout(timer);
      return { stdout };
    } catch {
      return { stdout: "" };
    }
  }

  async dispose(): Promise<void> {
    if (!this.containerId) return;
    const id = this.containerId;
    this.containerId = null;
    try {
      const proc = Bun.spawn([this.dockerBin, "rm", "-f", id], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    } catch {
      // best-effort cleanup
    }
  }

  writeRoot(): string | null {
    return this.projectDir;
  }
}
