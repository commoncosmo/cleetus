import type { WorkflowPackage } from "./package";

function inputSummary(workflow: WorkflowPackage): string {
  const schema = workflow.manifest.inputs;
  const properties =
    schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(properties)
    .slice(0, 12)
    .map(([name, property]) => {
      const type = typeof property.type === "string" ? property.type : "value";
      return `${name}:${type} ${required.has(name) ? "required" : "optional"}`;
    });
  if (fields.length === 0) return "inputs: none";
  const remainder = Object.keys(properties).length > fields.length ? ", …" : "";
  return `inputs: ${fields.join(", ")}${remainder}`;
}

export function renderWorkflowPromptHint(workflows: WorkflowPackage[]): string {
  if (workflows.length === 0) return "";
  const entries = workflows
    .slice(0, 50)
    .map(
      (workflow) =>
        `- ${workflow.name}: ${workflow.description} (${inputSummary(workflow)}; run with /workflow run ${workflow.name})`,
    )
    .join("\n");
  return [
    "## Activated strict workflows",
    entries,
    "",
    "Call `run_workflow` only when the user explicitly requests a named workflow. " +
      "If a workflow merely seems relevant, suggest `/workflow run <name>` instead. " +
      "Workflows are separate from skills; `/skill` does not execute them.",
  ].join("\n");
}
