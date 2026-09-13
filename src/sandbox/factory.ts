import type { SandboxConfig } from "../config/types";
import { bwrapPrefix } from "./bwrap";
import { detectHostBackend } from "./detect";
import { DockerSandbox } from "./docker";
import { HostSandbox } from "./host";
import { NoneSandbox } from "./none";
import { buildPolicy } from "./policy";
import { preflightHostSandbox } from "./preflight";
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
  /** Injectable so the host-jail health check stays deterministic in unit tests. */
  preflightHost?: (sandbox: HostSandbox) => Promise<string | null>;
}

const defaultDeps = (): FactoryDeps => ({
  platform: process.platform,
  hasBwrap: () => Bun.which("bwrap") != null,
  env: process.env,
});

export interface SandboxSelection {
  sandbox: Sandbox;
  /** True only when a host sandbox was requested but unavailable (automatic fallback). An
   *  explicit `backend: "none"` is an informed opt-in and is NOT degraded. */
  degraded: boolean;
  /** Actual backend after selection/preflight, suitable for user-facing status. */
  backend: "seatbelt" | "bubblewrap" | "docker" | "none";
}

/** Stable user-facing label for the active sandbox backend. */
export function sandboxStatus(backend: SandboxSelection["backend"], degraded: boolean): string {
  const label =
    backend === "seatbelt"
      ? "Seatbelt"
      : backend === "bubblewrap"
        ? "bubblewrap"
        : backend === "docker"
          ? "Docker"
          : "none";
  return `Sandbox: ${label}${degraded ? " (degraded)" : ""}`;
}

/**
 * Build the session sandbox from config with a degradation signal. `host` auto-resolves to
 * Seatbelt (macOS) or bubblewrap (Linux), then checks that wrapper with a harmless command. If
 * neither is available (Windows, bwrap-missing Linux) or the check fails, it logs a fallback
 * warning, degrades to `none`, and sets `degraded: true`. The sandbox is constructed once per
 * session, so the warning surfaces once per run (eval/improve never reach this path — they
 * require the docker backend and exit before constructing a host sandbox). `docker` defaults its
 * image instead of throwing. An explicit `backend: "none"` is an informed opt-in and never
 * marked degraded.
 */
export async function createSandboxWithInfo(
  cfg: SandboxConfig,
  projectDir: string,
  deps: FactoryDeps = defaultDeps(),
): Promise<SandboxSelection> {
  if (cfg.backend === "docker") {
    return {
      sandbox: new DockerSandbox(cfg.image ?? DEFAULT_DOCKER_IMAGE, projectDir, cfg.network),
      degraded: false,
      backend: "docker",
    };
  }
  if (cfg.backend === "host") {
    const kind = detectHostBackend(deps.platform, deps.hasBwrap);
    const policy = buildPolicy(deps.env, cfg.network);
    if (kind === "seatbelt" || kind === "bwrap") {
      const sandbox = new HostSandbox(
        projectDir,
        policy,
        kind === "seatbelt" ? seatbeltPrefix : bwrapPrefix,
      );
      const failure = await (deps.preflightHost ?? preflightHostSandbox)(sandbox);
      if (!failure) {
        return {
          sandbox,
          degraded: false,
          backend: kind === "seatbelt" ? "seatbelt" : "bubblewrap",
        };
      }
      console.error(
        `[cleetus] sandbox unavailable: ${kind} health check failed (${failure}) — falling back to none`,
      );
      return { sandbox: new NoneSandbox(projectDir), degraded: true, backend: "none" };
    }
    // unavailable (Windows, bwrap missing) → degrade to none (constructed once per session)
    console.error(
      `[cleetus] sandbox unavailable: no host-native sandbox on ${deps.platform} — falling back to none`,
    );
    return { sandbox: new NoneSandbox(projectDir), degraded: true, backend: "none" };
  }
  return { sandbox: new NoneSandbox(projectDir), degraded: false, backend: "none" };
}

/** Back-compat shape used by tests and non-policy callers. */
export async function createSandbox(
  cfg: SandboxConfig,
  projectDir: string,
  deps: FactoryDeps = defaultDeps(),
): Promise<Sandbox> {
  return (await createSandboxWithInfo(cfg, projectDir, deps)).sandbox;
}
