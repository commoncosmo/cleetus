import type { SandboxConfig } from "../config/types";
import { bwrapPrefix } from "./bwrap";
import { detectHostBackend } from "./detect";
import { DockerSandbox } from "./docker";
import { HostSandbox } from "./host";
import { NoneSandbox } from "./none";
import { buildPolicy } from "./policy";
import { seatbeltPrefix } from "./seatbelt";
import type { Sandbox } from "./types";

/** Default Docker image when `backend: docker` is set without an explicit image.
 *  Debian/glibc base (not Alpine/musl) to avoid native-binary surprises. */
export const DEFAULT_DOCKER_IMAGE = "oven/bun:1";

/** Injectable environment probes so the host branch is testable without touching globals. */
export interface FactoryDeps {
  platform: NodeJS.Platform;
  hasBwrap: () => boolean;
  env: Record<string, string | undefined>;
}

const defaultDeps = (): FactoryDeps => ({
  platform: process.platform,
  hasBwrap: () => Bun.which("bwrap") != null,
  env: process.env,
});

export interface SandboxSelection {
  sandbox: Sandbox;
  /** True only when a host sandbox was REQUESTED but unavailable (silent fallback). An
   *  explicit `backend: "none"` is an informed opt-in and is NOT degraded. */
  degraded: boolean;
}

/**
 * Build the session sandbox from config with a degradation signal. `host` auto-resolves to
 * Seatbelt (macOS) or bubblewrap (Linux); where neither is available (Windows, bwrap-missing
 * Linux) it logs a fallback warning, degrades to `none`, and sets `degraded: true`. The sandbox
 * is constructed once per session, so the warning surfaces once per run (eval/improve never
 * reach this path — they require the docker backend and exit before constructing a host
 * sandbox). `docker` defaults its image instead of throwing. An explicit `backend: "none"` is
 * an informed opt-in and never marked degraded.
 */
export function createSandboxWithInfo(
  cfg: SandboxConfig,
  projectDir: string,
  deps: FactoryDeps = defaultDeps(),
): SandboxSelection {
  if (cfg.backend === "docker") {
    return {
      sandbox: new DockerSandbox(cfg.image ?? DEFAULT_DOCKER_IMAGE, projectDir, cfg.network),
      degraded: false,
    };
  }
  if (cfg.backend === "host") {
    const kind = detectHostBackend(deps.platform, deps.hasBwrap);
    const policy = buildPolicy(deps.env, cfg.network);
    if (kind === "seatbelt") {
      return { sandbox: new HostSandbox(projectDir, policy, seatbeltPrefix), degraded: false };
    }
    if (kind === "bwrap") {
      return { sandbox: new HostSandbox(projectDir, policy, bwrapPrefix), degraded: false };
    }
    // unavailable (Windows, bwrap missing) → degrade to none (constructed once per session)
    console.error(
      `[cleetus] sandbox unavailable: no host-native sandbox on ${deps.platform} — falling back to none`,
    );
    return { sandbox: new NoneSandbox(projectDir), degraded: true };
  }
  return { sandbox: new NoneSandbox(projectDir), degraded: false };
}

/** Back-compat shape used by tests and non-policy callers. */
export function createSandbox(
  cfg: SandboxConfig,
  projectDir: string,
  deps: FactoryDeps = defaultDeps(),
): Sandbox {
  return createSandboxWithInfo(cfg, projectDir, deps).sandbox;
}
