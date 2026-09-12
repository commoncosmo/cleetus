import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

export interface PromoteCtx {
  projectDir: string;
  baseInstructions: string;
  now: number; // injected timestamp for the backup suffix
}
export interface WinningVariant {
  name: string;
  instructions: string; // the project-instructions block to write/diff
  systemPrompt: string; // the full composed prompt (for the candidate file)
}

/** The exact composition cleetus uses: global + project-instructions + memories. */
export function composePrompt(globalText: string, instructions: string, memories: string): string {
  return [globalText, instructions, memories].filter(Boolean).join("\n\n");
}

/**
 * A small set-based line summary (removed `-`, added `+`). Not a full LCS diff.
 * Duplicate lines are collapsed: only a line's presence/absence is tracked, not its
 * count, so a repeated line removed once may not show. Adequate for a human summary.
 */
export function diffLines(before: string, after: string): string {
  const beforeSet = new Set(before.split("\n"));
  const afterSet = new Set(after.split("\n"));
  const removed = before
    .split("\n")
    .filter((l) => !afterSet.has(l))
    .map((l) => `- ${l}`);
  const added = after
    .split("\n")
    .filter((l) => !beforeSet.has(l))
    .map((l) => `+ ${l}`);
  const out = [...removed, ...added].join("\n");
  return out.length > 0 ? out : "(no line changes)";
}

/** Default promotion: write a re-runnable candidate file + return a diff. Never touches the live agent. */
export async function proposeWinner(
  variant: WinningVariant,
  ctx: PromoteCtx,
): Promise<{ candidatePath: string; diff: string }> {
  const dir = join(ctx.projectDir, "candidates");
  await mkdir(dir, { recursive: true });
  const candidatePath = join(dir, `${basename(variant.name)}.yaml`);
  await writeFile(candidatePath, stringifyYaml({ system_prompt: variant.systemPrompt }));
  return { candidatePath, diff: diffLines(ctx.baseInstructions, variant.instructions) };
}

/** --apply: back up the existing instructions, then write the new block. */
export async function applyWinner(
  variant: WinningVariant,
  ctx: PromoteCtx,
): Promise<{ backupPath: string | null; instructionsPath: string }> {
  const instructionsPath = join(ctx.projectDir, ".cleetus", "instructions.md");
  let backupPath: string | null = null;
  try {
    const candidate = `${instructionsPath}.bak-${ctx.now}`;
    await copyFile(instructionsPath, candidate);
    backupPath = candidate;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // no existing instructions to back up
  }
  await mkdir(dirname(instructionsPath), { recursive: true });
  await writeFile(instructionsPath, variant.instructions);
  return { backupPath, instructionsPath };
}
