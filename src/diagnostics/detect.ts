import { join } from "node:path";
import type { ResolvedCmd } from "./types";

/** Resolve a binary on PATH, or null. */
export function onPath(bin: string): string | null {
  return Bun.which(bin);
}

/** True if `relPath` exists under projectDir. */
export async function hasFile(projectDir: string, relPath: string): Promise<boolean> {
  return await Bun.file(join(projectDir, relPath)).exists();
}

/** A project-local node_modules/.bin/<bin>, if present. */
export async function localBin(projectDir: string, bin: string): Promise<ResolvedCmd | null> {
  const p = join(projectDir, "node_modules", ".bin", bin);
  if (await Bun.file(p).exists()) return { command: p, baseArgs: [] };
  return null;
}
