import { stringify as stringifyYaml } from "yaml";
import type { WorkflowManifest } from "./parse";

export function renderWorkflowSkillAdapter(manifest: WorkflowManifest): string {
  const frontmatter = stringifyYaml({
    name: manifest.name,
    description: manifest.description,
    metadata: { "cleetus-workflow": "workflow.yaml" },
  }).trim();
  return [
    "---",
    frontmatter,
    "---",
    "",
    `Run the \`${manifest.name}\` Cleetus workflow when the user asks for this operation.`,
    `Use \`/workflow run ${manifest.name}\`; do not reproduce its steps manually.`,
    "",
  ].join("\n");
}
