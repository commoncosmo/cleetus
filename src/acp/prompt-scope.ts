import { join } from "node:path";
import { renderArtifactGrounding } from "../agent/environment";
import { MAIN_INSTR_LEAD, emphasizeInstructions } from "../agent/instructions";
import { inheritedProjectMemoryPath } from "../agent/tui-project-scope";
import { loadMemories } from "../memory/load";
import { composeAcpInstructions } from "./instructions";

export interface AcpPromptScopeArgs {
  globalDir: string;
  /** The core process cwd (existing `projectDir`), distinct from `projectHome`. */
  projectDir: string;
  instructionsFlag?: string;
  projectHome?: string;
  /** Default true. */
  inheritProjectInstructions?: boolean;
  /** Default true. */
  inheritProjectMemory?: boolean;
}

export interface AcpPromptScope {
  /** Emphasized instructions block (global → project-home → cwd walk), or "". */
  instructions: string;
  /** "## Memories" block (global + gated project-home), or "". */
  memories: string;
  /** One-line artifact-folder grounding, or "" when no project-home. */
  artifact: string;
}

/** Compose the once-per-process project-scope inputs the ACP system prompt bakes in. All three
 *  fields are static for the process lifetime (read at startup). The caller computes
 *  renderEnvironment from a session-pinned clock (so the prompt stays byte-stable) and appends `artifact` to it. */
export async function buildAcpPromptScope(args: AcpPromptScopeArgs): Promise<AcpPromptScope> {
  const instructions = emphasizeInstructions(
    await composeAcpInstructions({
      globalDir: args.globalDir,
      projectDir: args.projectDir,
      instructionsFlag: args.instructionsFlag,
      projectHome: args.projectHome,
      includeProjectInstructions: args.inheritProjectInstructions,
    }),
    MAIN_INSTR_LEAD,
  );

  const memories = loadMemories({
    globalPath: join(args.globalDir, "memory.md"),
    projectPath: inheritedProjectMemoryPath(
      args.projectDir,
      args.projectHome,
      args.inheritProjectMemory !== false,
    ),
  });

  const artifact = renderArtifactGrounding(args.projectHome);

  return { instructions, memories, artifact };
}
