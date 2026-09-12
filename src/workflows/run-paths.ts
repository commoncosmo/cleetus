import { join } from "node:path";

export function workflowRunDbPath(input: {
  projectDir?: string;
  configDir: string;
}): string {
  return input.projectDir
    ? join(input.projectDir, ".cleetus", "workflows.db")
    : join(input.configDir, "workflows.db");
}

export function workflowArtifactDir(input: {
  projectDir?: string;
  configDir: string;
  runId: string;
}): string {
  const root = input.projectDir ? join(input.projectDir, ".cleetus") : input.configDir;
  return join(root, "workflow-runs", input.runId, "artifacts");
}
