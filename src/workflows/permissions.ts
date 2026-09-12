import { resolve } from "node:path";
import type {
  WorkflowCommandPermission,
  WorkflowEffect,
  WorkflowFilesystemPermission,
  WorkflowNetworkPermission,
  WorkflowPermissions,
} from "./types";

export interface WorkflowPreflightSummary {
  permissions: WorkflowPermissions;
  maximumAttempts: number;
  maximumModelCalls: number;
  effect: WorkflowEffect;
  requiredSecrets: string[];
  unresolved: string[];
}

function normalizedHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("/") || host.includes(":")) {
    throw new Error(`invalid workflow network host '${value}'`);
  }
  return host;
}

function normalizedMethod(value: string): string {
  const method = value.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error(`invalid HTTP method '${value}'`);
  return method;
}

function normalizeNetwork(entries: WorkflowNetworkPermission[]): WorkflowNetworkPermission[] {
  const byHost = new Map<string, Set<string>>();
  for (const entry of entries) {
    const host = normalizedHost(entry.host);
    const methods = byHost.get(host) ?? new Set<string>();
    for (const method of entry.methods) methods.add(normalizedMethod(method));
    byHost.set(host, methods);
  }
  return [...byHost]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([host, methods]) => ({ host, methods: [...methods].sort() }));
}

function normalizeCommands(entries: WorkflowCommandPermission[]): WorkflowCommandPermission[] {
  const unique = new Map<string, WorkflowCommandPermission>();
  for (const entry of entries) {
    const program = entry.program.trim();
    if (!program) throw new Error("workflow command program must not be empty");
    const argsPrefix = entry.argsPrefix ? [...entry.argsPrefix] : undefined;
    const normalized = { program, ...(argsPrefix ? { argsPrefix } : {}) };
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function normalizeFilesystem(
  value: WorkflowFilesystemPermission,
  workspace?: string,
): WorkflowFilesystemPermission {
  const normalizePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) throw new Error("workflow filesystem capability must not be empty");
    if (!workspace || !trimmed.startsWith("$project/")) return trimmed;
    return resolve(workspace, trimmed.slice("$project/".length)).replaceAll("\\", "/");
  };
  return {
    read: [...new Set(value.read.map(normalizePath))].sort(),
    write: [...new Set(value.write.map(normalizePath))].sort(),
  };
}

export function normalizeWorkflowPermissions(
  value: Partial<WorkflowPermissions>,
  workspace?: string,
): WorkflowPermissions {
  return {
    network: normalizeNetwork(value.network ?? []),
    commands: normalizeCommands(value.commands ?? []),
    filesystem: normalizeFilesystem(value.filesystem ?? { read: [], write: [] }, workspace),
    model: value.model ?? false,
  };
}

function prefixCovered(required: string[], allowed: string[]): boolean {
  return (
    required.length >= allowed.length && allowed.every((value, index) => required[index] === value)
  );
}

function filesystemCovered(required: string, allowed: string): boolean {
  if (required === allowed) return true;
  if (!allowed.endsWith("/**")) return false;
  const prefix = allowed.slice(0, -3).replace(/\/+$/, "");
  return required === prefix || required.startsWith(`${prefix}/`);
}

export function workflowPermissionsContain(
  allowedInput: Partial<WorkflowPermissions>,
  requiredInput: Partial<WorkflowPermissions>,
  workspace?: string,
): boolean {
  const allowed = normalizeWorkflowPermissions(allowedInput, workspace);
  const required = normalizeWorkflowPermissions(requiredInput, workspace);
  if (required.model && !allowed.model) return false;
  for (const entry of required.network) {
    const match = allowed.network.find((candidate) => candidate.host === entry.host);
    if (!match || entry.methods.some((method) => !match.methods.includes(method))) return false;
  }
  for (const entry of required.commands) {
    const match = allowed.commands.some(
      (candidate) =>
        candidate.program === entry.program &&
        prefixCovered(entry.argsPrefix ?? [], candidate.argsPrefix ?? []),
    );
    if (!match) return false;
  }
  for (const path of required.filesystem.read) {
    if (!allowed.filesystem.read.some((candidate) => filesystemCovered(path, candidate)))
      return false;
  }
  for (const path of required.filesystem.write) {
    if (!allowed.filesystem.write.some((candidate) => filesystemCovered(path, candidate))) {
      return false;
    }
  }
  return true;
}

export function formatWorkflowPreflight(summary: WorkflowPreflightSummary): string {
  const permissionLines = [
    ...summary.permissions.network.map(
      (entry) => `network ${entry.methods.join(",")} ${entry.host}`,
    ),
    ...summary.permissions.commands.map(
      (entry) =>
        `command ${entry.program}${entry.argsPrefix?.length ? ` ${entry.argsPrefix.join(" ")}` : ""}`,
    ),
    ...summary.permissions.filesystem.read.map((path) => `read ${path}`),
    ...summary.permissions.filesystem.write.map((path) => `write ${path}`),
    ...(summary.permissions.model ? ["model generation"] : []),
  ];
  return [
    `Effect: ${summary.effect}`,
    `Maximum attempts: ${summary.maximumAttempts}`,
    `Maximum model calls: ${summary.maximumModelCalls}`,
    `Permissions: ${permissionLines.length ? permissionLines.join("; ") : "none"}`,
    `Secrets: ${summary.requiredSecrets.length ? [...summary.requiredSecrets].sort().join(", ") : "none"}`,
    `Unresolved: ${summary.unresolved.length ? [...summary.unresolved].sort().join(", ") : "none"}`,
  ].join("\n");
}
