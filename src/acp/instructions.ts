import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { composeInstructions, loadInstructions } from "../agent/instructions";

/** Load the app-supplied instructions file for the ACP runtime. Returns the composed instruction
 *  block, or "" when no path is given or the file is missing/unreadable/empty. Never throws — a
 *  bad path must never block a turn (a warning is logged to stderr). The single-element source
 *  array is the forward-compat seam: project-level sources get appended here later. */
export async function loadAcpInstructions(instructionsPath?: string): Promise<string> {
  if (!instructionsPath) return "";
  try {
    const text = await readFile(instructionsPath, "utf8");
    return composeInstructions([text]);
  } catch (err) {
    console.error(
      `[cleetus acp] WARNING: could not read --instructions ${instructionsPath}: ${err}`,
    );
    return "";
  }
}

/** Instructions for the ACP runtime: cleetus's native sources (config-dir `instructions.md` plus
 *  the cwd walk for `.cleetus/instructions.md`/`CLEETUS.md`) composed base-first with an optional
 *  explicit `--instructions` file. Never throws. */
export async function composeAcpInstructions(args: {
  globalDir: string;
  projectDir: string;
  instructionsFlag?: string;
  projectHome?: string;
  includeProjectInstructions?: boolean;
}): Promise<string> {
  const native = await loadInstructions({
    globalPath: join(args.globalDir, "instructions.md"),
    startDir: args.projectDir,
    projectHome: args.projectHome,
    includeProjectInstructions: args.includeProjectInstructions,
  });
  const flag = await loadAcpInstructions(args.instructionsFlag);
  return composeInstructions([native, flag]);
}
