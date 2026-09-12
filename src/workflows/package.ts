import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { renderWorkflowSkillAdapter } from "./adapter";
import { workflowExecutionHash, workflowPackageHash } from "./hashes";
import { type WorkflowManifest, parseWorkflowManifest } from "./parse";
import type { WorkflowSource } from "./types";

export interface WorkflowPackage {
  name: string;
  description: string;
  source: WorkflowSource;
  dir: string;
  manifestPath: string;
  manifest: WorkflowManifest;
  files: Array<{ path: string; content: string }>;
  runtimeResources: Array<{ path: string; content: string }>;
  packageHash: string;
  executionHash: string;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function readPackageFiles(root: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink())
        throw new Error(`workflow package contains symlink '${relative(root, path)}'`);
      if (info.isDirectory()) {
        visit(path);
        continue;
      }
      if (!info.isFile()) continue;
      out.push({
        path: relative(root, path).split(sep).join("/"),
        content: readFileSync(path, "utf8"),
      });
    }
  };
  visit(root);
  return out;
}

function resourcePaths(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    const normalized = value.replace(/^\.\//, "");
    if (normalized.startsWith("prompts/") || normalized.startsWith("scripts/")) out.add(normalized);
    return out;
  }
  if (Array.isArray(value)) {
    for (const child of value) resourcePaths(child, out);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) resourcePaths(child, out);
  }
  return out;
}

export function loadWorkflowPackage(
  dir: string,
  source: WorkflowSource,
  options: { archived?: boolean } = {},
): WorkflowPackage {
  const root = realpathSync(dir);
  if (!statSync(root).isDirectory()) throw new Error(`workflow package is not a directory: ${dir}`);
  const manifestPath = join(root, "workflow.yaml");
  const manifest = parseWorkflowManifest(readFileSync(manifestPath, "utf8"), manifestPath);
  if (!options.archived && basename(root) !== manifest.name) {
    throw new Error(
      `workflow directory '${basename(root)}' does not match manifest name '${manifest.name}'`,
    );
  }
  const files = readPackageFiles(root);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const runtimeResources = [...resourcePaths(manifest.steps)].sort().map((path) => {
    const file = byPath.get(path);
    if (!file) {
      const available = [...byPath.keys()].filter(
        (candidate) => candidate.startsWith("scripts/") || candidate.startsWith("prompts/"),
      );
      throw new Error(
        `workflow resource is missing: ${path}${available.length ? `; available packaged resources: ${available.join(", ")}` : ""}`,
      );
    }
    const absolute = realpathSync(join(root, path));
    if (!inside(root, absolute)) throw new Error(`workflow resource escapes package: ${path}`);
    return file;
  });
  return {
    name: manifest.name,
    description: manifest.description,
    source,
    dir: root,
    manifestPath,
    manifest,
    files,
    runtimeResources,
    packageHash: workflowPackageHash(files),
    executionHash: workflowExecutionHash(manifest, runtimeResources),
  };
}

export function expectedWorkflowAdapter(pkg: Pick<WorkflowPackage, "manifest">): string {
  return renderWorkflowSkillAdapter(pkg.manifest);
}
