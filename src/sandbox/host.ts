import type { SandboxPolicy } from "./policy";
import { spawnCollect } from "./spawn";
import type { ExecOptions, ExecResult, Sandbox } from "./types";

/** Lets subprocesses avoid trying to exercise a second host jail inside Cleetus's jail. */
export const CLEETUS_SANDBOX_ACTIVE_ENV = "CLEETUS_SANDBOX_ACTIVE";

/** Produces the argv prefix that jails a command for a given platform. */
export type ProfileProvider = (projectDir: string, policy: SandboxPolicy) => string[];

/**
 * Runs commands natively on the host, wrapped by a platform jail prefix (Seatbelt/bwrap).
 * Same OS/arch as the host → artifacts (installs/builds) are host-correct. No container
 * lifecycle, so `dispose` is a no-op.
 */
export class HostSandbox implements Sandbox {
  constructor(
    private readonly projectDir: string,
    private readonly policy: SandboxPolicy,
    private readonly prefix: ProfileProvider,
  ) {}

  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    const cwd = opts.cwd ?? this.projectDir;
    const policy = opts.protectProjectMetadata
      ? { ...this.policy, protectedProjectPaths: [".git", ".cleetus"] }
      : this.policy;
    const argv = [...this.prefix(this.projectDir, policy), "bash", "-c", command];
    return spawnCollect(argv, {
      ...opts,
      cwd,
      env: { ...opts.env, [CLEETUS_SANDBOX_ACTIVE_ENV]: "host" },
    });
  }

  async dispose(): Promise<void> {}

  writeRoot(): string | null {
    return this.projectDir;
  }
}
