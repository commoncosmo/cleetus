import { join } from "node:path";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

/** Explicit project selection wins over lockfiles; absent a selection, preserve lockfile ownership. */
export async function projectPackageManager(dir: string): Promise<PackageManager | undefined> {
  try {
    const pkg = await Bun.file(join(dir, "package.json")).json();
    const name = pkg.packageManager?.split("@")[0] ?? pkg.devEngines?.packageManager?.name;
    if (["bun", "npm", "pnpm", "yarn"].includes(name)) return name;
  } catch {}
  for (const [file, pm] of [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const) {
    if (await Bun.file(join(dir, file)).exists()) return pm;
  }
  return undefined;
}

/** Only rewrite simple package-management commands, never arbitrary Bun programs or shell scripts. */
export function consistentPackageCommand(command: string, pm: PackageManager | undefined): string {
  // Preserve the common output-trimming form without interpreting arbitrary shell code.
  const trimmedOutput = command.match(
    /^(.*?)(\s+(?:2>&1\s*)?\|\s*(?:Select-Object\s+-(?:Last|First)\s+\d+|(?:head|tail)\s+(?:-n\s+)?\d+)\s*)$/i,
  );
  if (trimmedOutput) return consistentPackageCommand(trimmedOutput[1]!, pm) + trimmedOutput[2];
  if (!pm || pm === "bun" || /[;&|`\r\n$<>]/.test(command)) return command;
  const match = command.match(/^\s*bun\s+(install|add|remove|run)\b(.*)$/);
  if (!match) return command;
  const [, action, rest = ""] = match;
  const sub =
    pm === "npm"
      ? (
          { install: "install", add: "install", remove: "uninstall", run: "run" } as Record<
            string,
            string
          >
        )[action!]
      : action;
  return `${pm} ${sub}${rest.replace(/(^|\s)-d(?=\s|$)/g, "$1-D")}`;
}
