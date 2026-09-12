import { join } from "node:path";

export interface DetectedBuildCommand {
  /** "script" → the project's `build` npm script; "tsc" → a typecheck fallback. */
  kind: "script" | "tsc";
  /** Argv to run, using the target project's package manager (data, not a command we run). */
  argv: string[];
}

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

async function exists(projectDir: string, rel: string): Promise<boolean> {
  return await Bun.file(join(projectDir, rel)).exists();
}

/** True when package.json parses and has a string `scripts.build`. Malformed → false. */
async function hasBuildScript(projectDir: string): Promise<boolean> {
  try {
    const raw = await Bun.file(join(projectDir, "package.json")).text();
    const pkg = JSON.parse(raw) as { scripts?: { build?: unknown } };
    return typeof pkg?.scripts?.build === "string";
  } catch {
    return false;
  }
}

async function packageManager(projectDir: string): Promise<PackageManager> {
  if ((await exists(projectDir, "bun.lock")) || (await exists(projectDir, "bun.lockb")))
    return "bun";
  if (await exists(projectDir, "pnpm-lock.yaml")) return "pnpm";
  if (await exists(projectDir, "yarn.lock")) return "yarn";
  return "npm";
}

/** One-off runner prefix for the chosen package manager (for `tsc --noEmit`). */
function execPrefix(pm: PackageManager): string[] {
  switch (pm) {
    case "bun":
      return ["bunx"];
    case "pnpm":
      return ["pnpm", "exec"];
    case "yarn":
      return ["yarn"];
    case "npm":
      return ["npx"];
  }
}

/**
 * Detect a build/coherence command for a project at `projectDir`. Prefers the project's `build`
 * script (runs the real bundler, e.g. `vite build`); falls back to `tsc --noEmit` when a tsconfig
 * exists but no build script; returns null when there is nothing to verify. Single root only.
 */
export async function detectBuildCommand(projectDir: string): Promise<DetectedBuildCommand | null> {
  if (await hasBuildScript(projectDir)) {
    const pm = await packageManager(projectDir);
    return { kind: "script", argv: [pm, "run", "build"] };
  }
  if (await exists(projectDir, "tsconfig.json")) {
    const pm = await packageManager(projectDir);
    return { kind: "tsc", argv: [...execPrefix(pm), "tsc", "--noEmit"] };
  }
  return null;
}
