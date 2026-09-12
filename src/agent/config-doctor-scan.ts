import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type ProjectSnapshot, type Violation, runRules } from "./config-doctor";

const PRUNE = new Set(["node_modules", ".git", "dist", "build", ".cleetus"]);
const VITE_CONFIG_NAMES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
  "vite.config.cts",
  "vite.config.cjs",
];
const MAX_DEPTH = 3;

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Dirs (depth <= MAX_DEPTH) holding a package.json, pruning ignored dirs. Paths relative to
 *  projectDir ("" for the root). */
async function findProjectRoots(projectDir: string): Promise<string[]> {
  const roots: string[] = [];
  async function walk(rel: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(join(projectDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "package.json")) roots.push(rel);
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !PRUNE.has(e.name))
        await walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  }
  await walk("", 0);
  return roots;
}

function dependsOnVite(packageJson: string): boolean {
  try {
    const pkg = JSON.parse(packageJson) as Record<string, Record<string, string> | undefined>;
    return "vite" in { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return false;
  }
}

async function snapshotFor(
  projectDir: string,
  root: string,
  packageJson: string,
): Promise<ProjectSnapshot> {
  let viteConfigPath: string | null = null;
  let viteConfigContent: string | null = null;
  for (const name of VITE_CONFIG_NAMES) {
    const content = await readOrNull(join(projectDir, root, name));
    if (content !== null) {
      viteConfigPath = root ? `${root}/${name}` : name;
      viteConfigContent = content;
      break;
    }
  }
  return { root: root || ".", packageJson, viteConfigPath, viteConfigContent };
}

/** Locate vite projects under `projectDir` (including nested ones) and return all wiring violations. */
export async function inspectProject(projectDir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const root of await findProjectRoots(projectDir)) {
    const pkg = await readOrNull(join(projectDir, root, "package.json"));
    if (!pkg || !dependsOnVite(pkg)) continue;
    violations.push(...runRules(await snapshotFor(projectDir, root, pkg)));
  }
  return violations;
}
