import type { EventSink } from "../events/types";
import type { JsonValue, WorkflowRunStatus, WorkflowStepStatus } from "./types";

export type WorkflowEvent =
  | {
      type: "run_status";
      runId?: string;
      workflow?: string;
      revision?: number;
      totalSteps?: number;
      status: WorkflowRunStatus;
    }
  | {
      type: "step_status";
      runId: string;
      workflow?: string;
      stepId: string;
      ordinal?: number;
      totalSteps?: number;
      uses?: string;
      status: WorkflowStepStatus;
      attempt?: number;
    }
  | { type: "run_output"; runId: string; outputs: JsonValue };

export interface WorkflowEventSink {
  emit(event: WorkflowEvent): void | Promise<void>;
}

export class WorkflowEventLogAdapter implements WorkflowEventSink {
  constructor(
    private readonly log: EventSink,
    private readonly sessionId: string,
  ) {}

  emit(event: WorkflowEvent): void {
    this.log.append({
      sessionId: this.sessionId,
      type: "workflow_status",
      payload: { workflowEvent: event },
    });
  }
}

export async function emitWorkflowEvent(
  sink: WorkflowEventSink | undefined,
  event: WorkflowEvent,
): Promise<void> {
  if (!sink) return;
  try {
    await sink.emit(event);
  } catch {
    // The workflow journal is authoritative; presentation/event mirroring is best-effort.
  }
}
