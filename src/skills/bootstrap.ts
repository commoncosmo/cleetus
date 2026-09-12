import { BUILTIN_SKILLS } from "./builtins";
import { discoverSkills } from "./discover";
import { renderSkillsHint } from "./prompt";
import { type SkillRegistry, buildSkillRegistry, skillRegistryWarnings } from "./registry";

export interface BootstrapSkillsOptions {
  startDir: string;
  globalDir: string;
  projectHome?: string;
  enabled: boolean;
  /** Suppress the system-prompt hint (e.g. one-shot `-p` runs that can't run /skill). */
  suppressHint?: boolean;
}

export interface BootstrapSkillsResult {
  registry: SkillRegistry;
  hint: string;
  warnings: string[];
}

/** Discover user skills (when enabled), merge with the built-ins, and render the hint. The
 *  single seam both the TUI (`src/bin/cleetus.ts`) and the ACP server (`src/acp/runtime.ts`)
 *  use, so skill wiring is identical across entry points. When disabled, discovery is
 *  skipped and the registry holds only built-ins (so `/skill` still works on them); the hint
 *  is empty when disabled or suppressed. */
export async function bootstrapSkills(
  opts: BootstrapSkillsOptions,
): Promise<BootstrapSkillsResult> {
  const discovered = opts.enabled
    ? await discoverSkills({
        startDir: opts.startDir,
        globalDir: opts.globalDir,
        projectHome: opts.projectHome,
      })
    : { skills: [], warnings: [] };
  const registry = buildSkillRegistry(BUILTIN_SKILLS, discovered.skills);
  const hint = opts.enabled && !opts.suppressHint ? renderSkillsHint(registry.list()) : "";
  return {
    registry,
    hint,
    warnings: [...discovered.warnings, ...skillRegistryWarnings(BUILTIN_SKILLS, discovered.skills)],
  };
}
