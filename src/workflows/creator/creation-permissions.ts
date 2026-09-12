import type { WorkflowManifest } from "../parse";
import { normalizeWorkflowPermissions } from "../permissions";
import { workflowReferencesIn } from "../references";
import type {
  WorkflowCommandPermission,
  WorkflowNetworkPermission,
  WorkflowPermissions,
} from "../types";
import type { WorkflowCreatorAuthoritySummary } from "./types";

function stepInput(step: WorkflowManifest["steps"][number]): Record<string, unknown> {
  if (!step.with || typeof step.with !== "object" || Array.isArray(step.with)) {
    throw new Error(`step '${step.id}' does not have an object input`);
  }
  return step.with;
}

function staticHttpPermission(step: WorkflowManifest["steps"][number]): WorkflowNetworkPermission {
  const input = stepInput(step);
  if (typeof input.url !== "string") {
    throw new Error(`step '${step.id}' requires a static HTTP URL`);
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error(`step '${step.id}' requires a valid static HTTP URL`);
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error(`step '${step.id}' requires a static HTTP or HTTPS host`);
  }
  if (workflowReferencesIn(url.origin).length > 0 || /[$}{]/u.test(url.hostname)) {
    throw new Error(`step '${step.id}' HTTP host cannot contain a runtime reference`);
  }
  const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET";
  return { host: url.hostname, methods: [method] };
}

function staticCommandPermission(
  step: WorkflowManifest["steps"][number],
): WorkflowCommandPermission {
  const input = stepInput(step);
  if (typeof input.program !== "string" || workflowReferencesIn(input.program).length > 0) {
    throw new Error(`step '${step.id}' command program must be static`);
  }
  const args = input.args === undefined ? [] : input.args;
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || workflowReferencesIn(arg).length > 0)
  ) {
    throw new Error(`step '${step.id}' command arguments must be static`);
  }
  return { program: input.program, argsPrefix: args as string[] };
}

function exactCommandKey(permission: WorkflowCommandPermission): string {
  return JSON.stringify({
    program: permission.program,
    argsPrefix: permission.argsPrefix ?? [],
  });
}

function networkLabels(entries: WorkflowNetworkPermission[]): string[] {
  return entries.flatMap((entry) =>
    entry.methods.map((method) => `network ${method} ${entry.host}`),
  );
}

function commandLabel(entry: WorkflowCommandPermission): string {
  return `command ${entry.program}${entry.argsPrefix?.length ? ` ${entry.argsPrefix.join(" ")}` : ""}`;
}

function runtimePermissions(manifest: WorkflowManifest): Partial<WorkflowPermissions> {
  return {
    network: (manifest.permissions.network ?? []).map((entry) => ({
      host: entry.host,
      methods: entry.methods,
    })),
    commands: (manifest.permissions.commands ?? []).map((entry) => ({
      program: entry.program,
      argsPrefix: entry.args_prefix,
    })),
    filesystem: {
      read: manifest.permissions.filesystem?.read ?? [],
      write: manifest.permissions.filesystem?.write ?? [],
    },
    ...(Object.hasOwn(manifest.permissions, "model") ? { model: manifest.permissions.model } : {}),
  };
}

export interface WorkflowCreationPermissionResult {
  permissions: WorkflowManifest["permissions"];
  authority: WorkflowCreatorAuthoritySummary;
}

export function deriveWorkflowCreationPermissions(
  manifest: WorkflowManifest,
): WorkflowCreationPermissionResult {
  const derivedNetwork: WorkflowNetworkPermission[] = [];
  const derivedCommands: WorkflowCommandPermission[] = [];
  let derivedModel = false;
  for (const step of manifest.steps) {
    if (step.uses === "http.request@1") derivedNetwork.push(staticHttpPermission(step));
    else if (step.uses === "command.run@1") {
      derivedCommands.push(staticCommandPermission(step));
    } else if (step.uses === "llm.generate@1") derivedModel = true;
  }

  const derived = normalizeWorkflowPermissions({
    network: derivedNetwork,
    commands: derivedCommands,
    model: derivedModel,
  });
  const declared = normalizeWorkflowPermissions(runtimePermissions(manifest));
  const declaredNetworkPresent = (manifest.permissions.network?.length ?? 0) > 0;
  const declaredCommandsPresent = (manifest.permissions.commands?.length ?? 0) > 0;
  const declaredModelPresent = Object.hasOwn(manifest.permissions, "model");

  if (declaredNetworkPresent) {
    for (const required of derived.network) {
      const match = declared.network.find((entry) => entry.host === required.host);
      if (!match || required.methods.some((method) => !match.methods.includes(method))) {
        throw new Error(
          `declared network authority conflicts with derived ${required.methods.join(",")} ${required.host}`,
        );
      }
    }
  }
  if (declaredCommandsPresent) {
    const declaredKeys = new Set(declared.commands.map(exactCommandKey));
    for (const required of derived.commands) {
      if (!declaredKeys.has(exactCommandKey(required))) {
        throw new Error(
          `declared command authority conflicts with derived ${commandLabel(required).slice("command ".length)}`,
        );
      }
    }
  }
  if (declaredModelPresent && declared.model !== derived.model) {
    throw new Error(
      `declared model authority conflicts with derived model=${String(derived.model)}`,
    );
  }

  const network = normalizeWorkflowPermissions({
    network: [...derived.network, ...declared.network],
  }).network;
  const commands = normalizeWorkflowPermissions({
    commands: [...derived.commands, ...declared.commands],
  }).commands;
  const derivedNetworkCapabilities = new Set(networkLabels(derived.network));
  const derivedCommandCapabilities = new Set(derived.commands.map(commandLabel));
  const explicitNetwork = networkLabels(network).filter(
    (capability) => !derivedNetworkCapabilities.has(capability),
  );
  const explicitCommands = commands
    .map(commandLabel)
    .filter((capability) => !derivedCommandCapabilities.has(capability));
  const explicitFilesystem = [
    ...declared.filesystem.read.map((path) => `read ${path}`),
    ...declared.filesystem.write.map((path) => `write ${path}`),
  ];
  const derivedLabels = [
    ...networkLabels(derived.network),
    ...derived.commands.map(commandLabel),
    ...(derived.model ? ["model calls"] : []),
  ].sort();
  const explicitLabels = [...explicitNetwork, ...explicitCommands, ...explicitFilesystem].sort();

  return {
    permissions: {
      ...(network.length > 0
        ? {
            network: network.map((entry) => ({
              host: entry.host,
              methods: entry.methods,
            })),
          }
        : {}),
      ...(commands.length > 0
        ? {
            commands: commands.map((entry) => ({
              program: entry.program,
              args_prefix: entry.argsPrefix,
            })),
          }
        : {}),
      ...(explicitFilesystem.length > 0
        ? {
            filesystem: {
              ...(declared.filesystem.read.length > 0 ? { read: declared.filesystem.read } : {}),
              ...(declared.filesystem.write.length > 0 ? { write: declared.filesystem.write } : {}),
            },
          }
        : {}),
      ...(derived.model ? { model: true } : {}),
    },
    authority: {
      derived: derivedLabels,
      explicit: explicitLabels,
    },
  };
}
