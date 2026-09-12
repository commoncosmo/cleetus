import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

export const MAX_FILE_BYTES = 262_144;
export const BINARY_SNIFF_BYTES = 8_192;
const GLOB_IGNORE = new Set(["node_modules", ".git", "dist", "build", ".cleetus"]);

async function gitFiles(projectDir: string): Promise<string[] | null> {
  try {
    const out = await $`git ls-files -z`.cwd(projectDir).quiet().text();
    if (!out) return [];
    return out.split("\0").filter((p) => p.length > 0);
  } catch {
    return null; // not a git repo / git unavailable
  }
}

/**
 * Recursive walk that PRUNES ignored directories by name at any depth — it never descends into
 * (or even lists the contents of) node_modules/.git/dist/build/.cleetus. This is the fallback for
 * non-git directories; pruning matters most there, since a non-git parent holding built JS
 * sub-projects would otherwise read every nested node_modules file (an ~82s, 30k-file scan). Does
 * not follow symlinks (Dirent.isDirectory() is false for symlinked dirs), matching prior behavior.
 */
async function globFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(projectDir, rel), { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (GLOB_IGNORE.has(e.name)) continue; // prune at any depth — never descend
        await walk(childRel);
      } else if (e.isFile()) {
        out.push(childRel);
      }
    }
  }
  await walk("");
  return out;
}

/**
 * True when any path segment is an ignored directory name. Applied to BOTH the git-tracked and
 * globbed candidate lists so a repo that commits node_modules/dist/build (no .gitignore) is pruned
 * the same as a clean one — otherwise `git ls-files` returns the whole dependency tree and startup
 * stat+reads every file (observed: 20,969 node_modules files, a 45s enumerate). globFiles already
 * prunes these directories as it walks, so this is a no-op for the non-git path.
 */
function hasIgnoredSegment(rel: string): boolean {
  for (const seg of rel.split("/")) if (GLOB_IGNORE.has(seg)) return true;
  return false;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function enumerateFiles(projectDir: string): Promise<string[]> {
  const candidates = ((await gitFiles(projectDir)) ?? (await globFiles(projectDir))).filter(
    (rel) => !hasIgnoredSegment(rel),
  );
  const result: string[] = [];
  for (const rel of candidates) {
    const abs = join(projectDir, rel);
    try {
      const st = await stat(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(abs);
      if (isBinary(buf)) continue;
      result.push(rel);
    } catch {
      // unreadable / vanished — skip
    }
  }
  return result;
}
