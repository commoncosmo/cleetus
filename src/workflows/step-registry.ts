import type { ResolvedValue } from "./provenance";
import type {
  JsonSchema,
  JsonValue,
  WorkflowEffect,
  WorkflowPermissions,
  WorkflowRetryClass,
} from "./types";

export interface WorkflowStepClassification {
  effect: WorkflowEffect;
  permissions: Partial<WorkflowPermissions>;
  retryable: WorkflowRetryClass[];
  dangerousInputPaths?: string[];
}

export interface WorkflowStepContext {
  signal: AbortSignal;
  runId: string;
  stepId?: string;
  workspace: string;
  permissions?: WorkflowPermissions;
}

export interface WorkflowStepType<
  Input extends JsonValue = JsonValue,
  Output extends JsonValue = JsonValue,
> {
  name: string;
  version: number;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  defaultTimeoutMs?: number;
  classify(input: Input): WorkflowStepClassification;
  preview(input: Input): string;
  execute(
    input: ResolvedValue<Input>,
    context: WorkflowStepContext,
  ): Promise<ResolvedValue<Output>>;
}

export function stepTypeKey(name: string, version: number): string {
  return `${name}@${version}`;
}

export function parseStepTypeKey(value: string): { name: string; version: number } {
  const match = /^([a-z][a-z0-9.-]*)@([1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`invalid pinned workflow step type '${value}'`);
  return { name: match[1]!, version: Number(match[2]) };
}

export class WorkflowStepRegistry {
  private readonly types = new Map<string, WorkflowStepType>();

  register(type: WorkflowStepType): void {
    const key = stepTypeKey(type.name, type.version);
    if (this.types.has(key)) throw new Error(`duplicate workflow step type '${key}'`);
    this.types.set(key, type);
  }

  get(key: string): WorkflowStepType | undefined {
    return this.types.get(key);
  }

  require(key: string): WorkflowStepType {
    const type = this.get(key);
    if (!type) throw new Error(`workflow step type '${key}' is not available`);
    return type;
  }

  list(): WorkflowStepType[] {
    return [...this.types.values()].sort((a, b) =>
      stepTypeKey(a.name, a.version).localeCompare(stepTypeKey(b.name, b.version)),
    );
  }
}
