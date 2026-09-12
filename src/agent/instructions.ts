import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

/** The lead sentence introducing user instructions in the main system prompt. Shared by the TUI
 *  (src/bin/cleetus.ts) and the ACP runtime so both wrap instructions identically. */
export const MAIN_INSTR_LEAD =
  "USER INSTRUCTIONS — standing preferences that take precedence over the default guidance below:";

/** Join instruction sources into one block: trim each, drop empties, join with a blank line.
 *  The ORDER is the layering order — earlier sources are the base, later sources stack on top.
 *  Today the ACP runtime passes [appWideFileText]; project-level stacking later appends more
 *  sources without changing this function. Pure. */
export function composeInstructions(sources: string[]): string {
  return sources
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    await access(path);
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function findFirstAncestor(startDir: string, filename: string): Promise<string | null> {
  let cur = startDir;
  const root = parse(cur).root;
  while (true) {
    const candidate = join(cur, filename);
    if ((await readIfExists(candidate)) !== null) return candidate;
    if (cur === root) return null;
    cur = dirname(cur);
  }
}

/** realpath, or null when the path is missing/unresolvable. Used to dedup the project-home
 *  instructions file against the cwd ancestor-walk hit when cwd lives under the home. */
async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export interface LoadInstructionsOptions {
  globalPath: string;
  startDir: string;
  /** Project-home scope anchor, distinct from startDir(cwd). When set (and not opted out),
   *  `<projectHome>/.cleetus/instructions.md` is folded in between global and the cwd walk. */
  projectHome?: string;
  /** Default true. When false, all project sources are skipped: project-home, cwd ancestry,
   *  and CLEETUS.md. Global instructions still apply. */
  includeProjectInstructions?: boolean;
}

/** Resolve the instruction files that currently contribute, in layering order. */
export async function instructionSourcePaths(opts: LoadInstructionsOptions): Promise<string[]> {
  const paths: string[] = [];

  if ((await readIfExists(opts.globalPath)) !== null) paths.push(opts.globalPath);

  // Project-home tier: read <projectHome>/.cleetus/instructions.md directly (NOT via the ancestor
  // walk). Track its resolved path so the cwd walk below never re-adds the same file.
  let projectHomeInstrReal: string | null = null;
  if (opts.projectHome && opts.includeProjectInstructions !== false) {
    const homeInstr = join(opts.projectHome, ".cleetus", "instructions.md");
    const text = await readIfExists(homeInstr);
    if (text !== null) {
      paths.push(homeInstr);
      projectHomeInstrReal = await realpathIfExists(homeInstr);
    }
  }

  if (opts.includeProjectInstructions !== false) {
    const projectInstr = await findFirstAncestor(
      opts.startDir,
      join(".cleetus", "instructions.md"),
    );
    if (projectInstr) {
      const real = await realpathIfExists(projectInstr);
      const isDup = projectHomeInstrReal !== null && real === projectHomeInstrReal;
      if (!isDup) paths.push(projectInstr);
    }

    const cleetusMd = await findFirstAncestor(opts.startDir, "CLEETUS.md");
    if (cleetusMd) paths.push(cleetusMd);
  }

  return paths;
}

export async function loadInstructions(opts: LoadInstructionsOptions): Promise<string> {
  const sections = await Promise.all(
    (await instructionSourcePaths(opts)).map((path) => readFile(path, "utf8")),
  );
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Wrap a non-empty instructions string in a labeled, emphasis-marked block; "" when blank.
 *  Generic — the caller supplies the lead sentence for its context (main prompt vs orchestrator). */
export function emphasizeInstructions(instructions: string, lead: string): string {
  const body = instructions.trim();
  return body ? `${lead}\n${body}` : "";
}
