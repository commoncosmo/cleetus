import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type WorkflowPackage, loadWorkflowPackage } from "./package";
import type { WorkflowSource } from "./types";

export interface WorkflowDiagnostic {
  level: "warning" | "error";
  source: WorkflowSource;
  path: string;
  message: string;
}

export interface DiscoveredWorkflows {
  workflows: WorkflowPackage[];
  diagnostics: WorkflowDiagnostic[];
}

function discoverScope(root: string, source: WorkflowSource): DiscoveredWorkflows {
  const workflows: WorkflowPackage[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];
  if (!existsSync(root)) return { workflows, diagnostics };
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (!existsSync(join(dir, "workflow.yaml"))) continue;
      workflows.push(loadWorkflowPackage(dir, source));
    } catch (error) {
      diagnostics.push({
        level: "error",
        source,
        path: dir,
        message: (error as Error).message,
      });
    }
  }
  return { workflows, diagnostics };
}

export function discoverWorkflows(input: {
  projectDir: string;
  globalDir: string;
}): DiscoveredWorkflows {
  const project = discoverScope(join(input.projectDir, ".cleetus", "workflows"), "project");
  const global = discoverScope(join(input.globalDir, "workflows"), "global");
  return {
    workflows: [...project.workflows, ...global.workflows],
    diagnostics: [...project.diagnostics, ...global.diagnostics],
  };
}
