import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import type { WorkflowDraftRecord } from "./types";

export class WorkflowDraftStore {
  constructor(private readonly workflowsRoot: string) {}

  private dir(id: string): string {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)) throw new Error("invalid workflow draft id");
    return join(this.workflowsRoot, ".drafts", id);
  }

  create(input: {
    scope: "project" | "global";
    name?: string;
    sessionId?: string;
    targetRevision?: number;
    creationProtocol?: WorkflowDraftRecord["creationProtocol"];
    revisionProtocol?: WorkflowDraftRecord["revisionProtocol"];
    revisionBase?: WorkflowDraftRecord["revisionBase"];
    baseManifest?: WorkflowDraftRecord["baseManifest"];
    baseResources?: WorkflowDraftRecord["baseResources"];
  }): WorkflowDraftRecord {
    const now = new Date().toISOString();
    const record: WorkflowDraftRecord = {
      id: ulid(),
      sessionId: input.sessionId,
      scope: input.scope,
      name: input.name,
      targetRevision: input.targetRevision,
      creationProtocol: input.creationProtocol,
      revisionProtocol: input.revisionProtocol,
      revisionBase: input.revisionBase,
      baseManifest: input.baseManifest,
      baseResources: input.baseResources,
      phase: "questions",
      createdAt: now,
      updatedAt: now,
      messages: [],
      ...(input.creationProtocol === "blueprint-v1" ? { requirementMessages: [] } : {}),
      diagnostics: [],
    };
    this.save(record);
    return record;
  }

  save(record: WorkflowDraftRecord): void {
    const dir = this.dir(record.id);
    mkdirSync(dir, { recursive: true });
    record.updatedAt = new Date().toISOString();
    writeFileSync(join(dir, "draft.json"), `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  get(id: string): WorkflowDraftRecord | undefined {
    const path = join(this.dir(id), "draft.json");
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as WorkflowDraftRecord;
  }

  packageDir(id: string): string {
    return join(this.dir(id), "package");
  }

  list(): WorkflowDraftRecord[] {
    const root = join(this.workflowsRoot, ".drafts");
    if (!existsSync(root)) return [];
    const records: WorkflowDraftRecord[] = [];
    for (const id of readdirSync(root).sort()) {
      try {
        const record = this.get(id);
        if (record) records.push(record);
      } catch {
        // One corrupt draft must not hide the rest.
      }
    }
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  latest(sessionId?: string): WorkflowDraftRecord | undefined {
    return this.list().find(
      (record) =>
        record.phase !== "activated" &&
        (sessionId === undefined ||
          record.sessionId === sessionId ||
          record.sessionId === undefined),
    );
  }

  discard(id: string): void {
    const dir = this.dir(id);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
}
