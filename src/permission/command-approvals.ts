import { addRule } from "./grant";
import { persistRule } from "./persist";
import type { PermissionRule, PermissionRules } from "./types";

export type CommandApprovalScope = "session" | "project" | "global";
export interface CommandApprovalStore {
  rules?: PermissionRules;
  sessionRules: PermissionRule[];
  projectDir: string;
  persistPath?: string;
  globalPath?: string;
  globalConfigPath?: string;
  trustGlobalWorkspace?: boolean;
}

export async function updateCommandApproval(
  store: CommandApprovalStore,
  rule: Omit<PermissionRule, "decision">,
  scope: CommandApprovalScope,
  remove = false,
): Promise<void> {
  const entry = { ...rule, decision: "allow" as const };
  const matches = (candidate: PermissionRule) =>
    candidate.commandPattern === entry.commandPattern &&
    candidate.commandCwd === entry.commandCwd &&
    candidate.commandShell === entry.commandShell &&
    candidate.tool === "bash" &&
    candidate.decision === "allow";
  const layer = scope === "session" ? store.sessionRules : store.rules?.[scope];
  if (!layer) throw new Error("Command approval storage unavailable");
  if (scope !== "session") {
    const path = scope === "project" ? store.persistPath : store.globalPath;
    if (!path) throw new Error("Saved command approval path unavailable");
    await persistRule(
      path,
      entry,
      scope === "project" && store.globalConfigPath
        ? {
            projectDir: store.projectDir,
            globalPath: store.globalConfigPath,
            trustGlobalWorkspace: store.trustGlobalWorkspace,
          }
        : undefined,
      remove ? "remove" : "add",
    );
  }
  if (remove) {
    for (let i = layer.length - 1; i >= 0; i--) if (matches(layer[i]!)) layer.splice(i, 1);
  } else if (scope === "session") {
    if (!layer.some(matches)) layer.push(entry);
  } else addRule(store.rules!, scope, rule);
}
