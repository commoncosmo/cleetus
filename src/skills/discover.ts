import type { Dirent } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, parse as parsePath, relative, resolve } from "node:path";
import { parseSkillFile } from "./parse";
import type { Skill, SkillSource } from "./types";

/** Max bundled files surfaced per directory skill (pathological-tree guard). */
const RESOURCE_CAP = 100;

/** Walk ancestors from `startDir` looking for a `.cleetus/skills` directory. */
async function findProjectSkillsDir(startDir: string): Promise<string | null> {
  // Resolve to an absolute path so the ancestor walk has a real filesystem root to
  // terminate at (a relative startDir would never reach `root` and could loop).
  let cur = resolve(startDir);
  const root = parsePath(cur).root;
  while (true) {
    const candidate = join(cur, ".cleetus", "skills");
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // not here; keep walking
    }
    if (cur === root) return null;
    cur = dirname(cur);
  }
}

/** Recursively list regular files under `root`, relative to `root`, sorted, excluding the
 *  top-level `SKILL.md`. Symlinks are not followed. Never throws; on a read error a subtree
 *  is skipped. Returns the capped list plus whether it was truncated. */
async function listResources(root: string): Promise<{ resources: string[]; truncated: boolean }> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const rel = relative(root, full);
        if (rel === "SKILL.md") continue; // exclude the entrypoint (top-level only)
        out.push(rel);
      }
      // symlinks: isDirectory()/isFile() are false for a symlink Dirent → skipped
    }
  }
  await walk(root);
  out.sort();
  const truncated = out.length > RESOURCE_CAP;
  return { resources: truncated ? out.slice(0, RESOURCE_CAP) : out, truncated };
}

async function readSkillsFrom(
  dir: string,
  source: SkillSource,
): Promise<{ skills: Skill[]; warnings: string[] }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { skills: [], warnings: [] };
  }
  const skills: Skill[] = [];
  const warnings: string[] = [];
  // Track which names came from a flat file so a same-named directory skill can override it.
  const flatByName = new Set<string>();

  const flat = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  // Flat *.md files first.
  for (const e of flat) {
    const full = join(dir, e.name);
    let content: string;
    try {
      content = await readFile(full, "utf8");
    } catch {
      warnings.push(`could not read skill ${full}`);
      continue;
    }
    const parsed = parseSkillFile(content, e.name);
    if (!parsed) {
      warnings.push(`skipped empty skill ${full}`);
      continue;
    }
    skills.push({ ...parsed, source, filePath: full });
    flatByName.add(parsed.name);
  }

  // Then directories containing SKILL.md (a directory skill overrides a same-named flat one).
  for (const e of dirs) {
    const skillDir = join(dir, e.name);
    const entry = join(skillDir, "SKILL.md");
    let content: string;
    try {
      content = await readFile(entry, "utf8");
    } catch (err) {
      // Missing SKILL.md → not a skill (silent). Any other read error → warn.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`could not read skill ${entry}`);
      }
      continue;
    }
    const parsed = parseSkillFile(content, e.name);
    if (!parsed) {
      warnings.push(`skipped empty skill ${entry}`);
      continue;
    }
    const { resources, truncated } = await listResources(skillDir);
    if (truncated) {
      warnings.push(
        `skill ${entry}: more than ${RESOURCE_CAP} bundled files; keeping the first ${RESOURCE_CAP}`,
      );
    }
    if (flatByName.has(parsed.name)) {
      const idx = skills.findIndex((s) => s.name === parsed.name && s.baseDir === undefined);
      if (idx >= 0) skills.splice(idx, 1);
      warnings.push(
        `skill '${parsed.name}' from ${entry} shadows a same-named flat skill in ${dir}`,
      );
    }
    skills.push({ ...parsed, source, filePath: entry, baseDir: skillDir, resources });
  }

  return { skills, warnings };
}

/** Discover user-authored skills from cwd ancestry, an explicit project home, and the global
 * `<globalDir>/skills`. Missing directories are ignored. */
export async function discoverSkills(opts: {
  startDir: string;
  globalDir: string;
  /** Explicit project scope anchor. Its skills layer over cwd-discovered project skills. */
  projectHome?: string;
}): Promise<{ skills: Skill[]; warnings: string[] }> {
  const cwdProjectDir = await findProjectSkillsDir(opts.startDir);
  const homeProjectDir = opts.projectHome
    ? join(resolve(opts.projectHome), ".cleetus", "skills")
    : null;
  const sameProjectDir =
    cwdProjectDir && homeProjectDir
      ? await Promise.all([realpath(cwdProjectDir), realpath(homeProjectDir)])
          .then(([cwd, home]) => cwd === home)
          .catch(() => resolve(cwdProjectDir) === resolve(homeProjectDir))
      : false;
  const cwdProject = cwdProjectDir
    ? await readSkillsFrom(cwdProjectDir, "project")
    : { skills: [], warnings: [] };
  const homeProject =
    homeProjectDir && !sameProjectDir
      ? await readSkillsFrom(homeProjectDir, "project")
      : { skills: [], warnings: [] };
  const global = await readSkillsFrom(join(opts.globalDir, "skills"), "global");
  return {
    // Project-home is the explicit app/user scope, so it comes after cwd and wins same-name
    // collisions when buildSkillRegistry applies last-write-wins project precedence.
    skills: [...cwdProject.skills, ...homeProject.skills, ...global.skills],
    warnings: [...cwdProject.warnings, ...homeProject.warnings, ...global.warnings],
  };
}
