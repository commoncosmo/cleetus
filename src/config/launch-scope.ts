import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { SCRATCH_PREFIX } from "./scratch-lifecycle";

export type LaunchKind = "project" | "global" | "scratch";

export interface LaunchScope {
  /** Which mode this launch is in. */
  kind: LaunchKind;
  /** Absolute working directory. For global/scratch the caller chdirs here. */
  dir: string;
  /** scratch only: the dir is a throwaway temp dir to remove on exit. */
  ephemeral: boolean;
  /** Default scope for the `remember` tool when the model omits `scope`. */
  defaultMemoryScope: "project" | "global";
  /** Status-bar tag; undefined for the project kind. */
  label?: "global" | "scratch";
}

export interface ResolveLaunchScopeInput {
  global: boolean;
  scratch: boolean;
  /** realpath(process.cwd()); the project-kind working dir. */
  cwd: string;
  /** --project-dir; presence conflicts with global/scratch. */
  projectHome?: string;
  /** os.homedir(). */
  home: string;
  /** config.globalWorkspaceDir (raw string), or undefined → ~/.cleetus. */
  globalWorkspaceDir?: string;
  /** Injected for testability; defaults to a fresh mkdtemp under os.tmpdir(). */
  makeScratchDir?: () => string;
}

/** Turn a configured global_workspace_dir into an absolute path: `~`/`~/x` expand to home, a
 *  relative path resolves against home, an absolute path is used as-is. Unset → ~/.cleetus. */
function resolveGlobalDir(configured: string | undefined, home: string): string {
  if (!configured) return join(home, ".cleetus");
  if (configured === "~") return home;
  if (configured.startsWith("~/")) return join(home, configured.slice(2));
  return isAbsolute(configured) ? configured : join(home, configured);
}

export function resolveLaunchScope(input: ResolveLaunchScopeInput): LaunchScope {
  if (input.global && input.scratch) {
    throw new Error("choose one of --global / --scratch, not both");
  }
  if ((input.global || input.scratch) && input.projectHome) {
    throw new Error("--project-dir conflicts with --global/--scratch (they set the working dir)");
  }
  if (input.global) {
    return {
      kind: "global",
      dir: resolveGlobalDir(input.globalWorkspaceDir, input.home),
      ephemeral: false,
      defaultMemoryScope: "global",
      label: "global",
    };
  }
  if (input.scratch) {
    const make = input.makeScratchDir ?? (() => mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)));
    return {
      kind: "scratch",
      dir: make(),
      ephemeral: true,
      defaultMemoryScope: "global",
      label: "scratch",
    };
  }
  return { kind: "project", dir: input.cwd, ephemeral: false, defaultMemoryScope: "project" };
}

export interface LaunchScopeIo {
  chdir: (dir: string) => void;
  mkdirp: (dir: string) => void;
  registerCleanup: (dir: string) => void;
  reapStale: () => void;
}

/** Resolve the scope and apply its side effects through injected io: always sweep stale scratch
 *  dirs; for global/scratch create + chdir into the dir; for scratch register cleanup. */
export function establishLaunchScope(
  input: ResolveLaunchScopeInput,
  io: LaunchScopeIo,
): LaunchScope {
  const scope = resolveLaunchScope(input);
  io.reapStale();
  if (scope.kind !== "project") {
    io.mkdirp(scope.dir);
    io.chdir(scope.dir);
  }
  if (scope.ephemeral) io.registerCleanup(scope.dir);
  return scope;
}
