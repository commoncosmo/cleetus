import { createHash } from "node:crypto";
import type { WorkflowManifest } from "./parse";

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function hashEntries(entries: Array<{ path: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(normalizeText(entry.content));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function normalizedManifestContent(manifest: WorkflowManifest): string {
  return `${JSON.stringify(stable(manifest), null, 2)}\n`;
}

export function workflowPackageHash(files: Array<{ path: string; content: string }>): string {
  return hashEntries(files);
}

export function workflowExecutionHash(
  manifest: WorkflowManifest,
  runtimeResources: Array<{ path: string; content: string }>,
): string {
  return hashEntries([
    { path: "workflow.yaml", content: normalizedManifestContent(manifest) },
    ...runtimeResources,
  ]);
}
