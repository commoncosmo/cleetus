import { join } from "node:path";

/** Stable write location for project-scoped memory. An explicit project home wins; loose
 * sessions use their cwd. */
export function projectMemoryPath(cwd: string, projectHome?: string): string {
  return join(projectHome ?? cwd, ".cleetus", "memory.md");
}

/** Project memory inherited into the prompt. Opting out suppresses it entirely; otherwise an
 * explicit project home wins and loose sessions inherit their cwd memory. Shared by TUI + ACP. */
export function inheritedProjectMemoryPath(
  cwd: string,
  projectHome: string | undefined,
  inheritProjectMemory: boolean,
): string | undefined {
  return inheritProjectMemory ? projectMemoryPath(cwd, projectHome) : undefined;
}
