import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { normalizeWorkflowPermissions, workflowPermissionsContain } from "./permissions";
import type { WorkflowPermissions, WorkflowScope } from "./types";

export type WorkflowGrantDecision = "allow" | "deny";
export type WorkflowAuthorization = "allow_once" | "trust_revision" | "deny";

export interface WorkflowGrantRecord {
  workflow: string;
  executionHash: string;
  permissions: WorkflowPermissions;
  decision: WorkflowGrantDecision;
  updatedAt: string;
}

interface GrantFile {
  version: 1;
  grants: WorkflowGrantRecord[];
}

function emptyFile(): GrantFile {
  return { version: 1, grants: [] };
}

function readGrantFile(path: string): GrantFile {
  if (!existsSync(path)) return emptyFile();
  const value = parse(readFileSync(path, "utf8")) as Partial<GrantFile> | null;
  if (!value || value.version !== 1 || !Array.isArray(value.grants)) {
    throw new Error(`invalid workflow grant file '${path}'`);
  }
  return { version: 1, grants: value.grants };
}

function writeGrantFile(path: string, value: GrantFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, stringify(value), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}

export interface WorkflowGrantLookup {
  decision: "allow" | "deny" | "missing";
  scope?: WorkflowScope;
  record?: WorkflowGrantRecord;
}

export class WorkflowGrantStore {
  constructor(
    private readonly projectPath: string | undefined,
    private readonly globalPath: string,
  ) {}

  lookup(input: {
    workflow: string;
    executionHash: string;
    permissions: WorkflowPermissions;
  }): WorkflowGrantLookup {
    const sources: Array<{ scope: WorkflowScope; path: string }> = [];
    if (this.projectPath) sources.push({ scope: "project", path: this.projectPath });
    sources.push({ scope: "global", path: this.globalPath });
    for (const source of sources) {
      const matching = readGrantFile(source.path).grants.filter(
        (grant) => grant.workflow === input.workflow && grant.executionHash === input.executionHash,
      );
      const deny = matching.find((grant) => grant.decision === "deny");
      if (deny) return { decision: "deny", scope: source.scope, record: deny };
      const allow = matching.find(
        (grant) =>
          grant.decision === "allow" &&
          workflowPermissionsContain(grant.permissions, input.permissions),
      );
      if (allow) return { decision: "allow", scope: source.scope, record: allow };
    }
    return { decision: "missing" };
  }

  persist(
    scope: WorkflowScope,
    input: Omit<WorkflowGrantRecord, "updatedAt">,
  ): WorkflowGrantRecord {
    const path = scope === "project" ? this.projectPath : this.globalPath;
    if (!path) throw new Error("project workflow grants are unavailable outside a project");
    const file = readGrantFile(path);
    const normalized: WorkflowGrantRecord = {
      ...input,
      permissions: normalizeWorkflowPermissions(input.permissions),
      updatedAt: new Date().toISOString(),
    };
    file.grants = file.grants.filter(
      (grant) =>
        !(
          grant.workflow === normalized.workflow && grant.executionHash === normalized.executionHash
        ),
    );
    file.grants.push(normalized);
    file.grants.sort((left, right) =>
      `${left.workflow}\0${left.executionHash}`.localeCompare(
        `${right.workflow}\0${right.executionHash}`,
      ),
    );
    writeGrantFile(path, file);
    return normalized;
  }
}
