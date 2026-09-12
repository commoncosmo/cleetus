import securityScanMd from "./builtins/security-scan.md" with { type: "text" };
import specCreatorMd from "./builtins/spec-creator.md" with { type: "text" };
import tddMd from "./builtins/test-driven-development.md" with { type: "text" };
import workflowCreatorMd from "./builtins/workflow-creator.md" with { type: "text" };
import { parseSkillFile } from "./parse";
import type { Skill } from "./types";

/** Parse an embedded builtin markdown file into a Skill, or throw. Bundled skills are
 *  authored (not user input): a parse failure is a build/authoring error and must fail
 *  loudly rather than silently drop a builtin. */
function loadBuiltin(md: string, filename: string): Skill {
  const parsed = parseSkillFile(md, filename);
  if (!parsed) throw new Error(`built-in skill ${filename} failed to parse (empty body?)`);
  return { ...parsed, source: "built-in" };
}

/** Skills bundled with cleetus, authored as markdown under `./builtins/*.md` in the same
 *  format as user skills (see docs/skills.md) and embedded into the compiled binary via
 *  Bun text imports. */
export const BUILTIN_SKILLS: Skill[] = [
  loadBuiltin(securityScanMd, "security-scan.md"),
  loadBuiltin(tddMd, "test-driven-development.md"),
  loadBuiltin(specCreatorMd, "spec-creator.md"),
  loadBuiltin(workflowCreatorMd, "workflow-creator.md"),
];
