import { readlinkSync } from "node:fs";
import { win32 } from "node:path";

/** Bun 1.3 cannot stat App Execution Aliases even when Windows can launch them.
 * Resolve their registered target without running a shell or changing PATH. */
function aliasTarget(path: string, readLink: (path: string) => string): string {
  if (/[\\/]WindowsApps[\\/]/i.test(path)) {
    try {
      return win32.resolve(win32.dirname(path), readLink(path));
    } catch {
      /* Ordinary package executable or unavailable alias. */
    }
  }
  return path;
}

export function findPowerShell(
  which: (name: string) => string | null = Bun.which,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  readLink: (path: string) => string = readlinkSync,
): string | null {
  if (platform === "win32") {
    const path = Object.entries(env).find(([name]) => name.toLowerCase() === "path")?.[1];
    for (const entry of path?.split(";") ?? []) {
      if (!entry.trim()) continue;
      const candidate = win32.join(entry.replace(/^"|"$/g, ""), "pwsh.exe");
      const found = which(aliasTarget(candidate, readLink));
      if (found) return found;
    }
  }
  return which("pwsh.exe");
}

/** Preserve the selected installation, resolving its Store alias if necessary.
 * WindowsSandbox.healthCheck probes the actual MXC launch, regardless of path. */
export async function resolvePowerShell(
  path: string | null,
  readLink: (path: string) => string = readlinkSync,
): Promise<string | null> {
  return path ? aliasTarget(path, readLink) : null;
}
