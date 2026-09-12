import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";
import { openDatabase } from "../lib/db";
import type { ResolvedValue } from "./provenance";
import type { JsonValue, WorkflowEffect, WorkflowRunStatus, WorkflowStepStatus } from "./types";

export interface WorkflowRunRecord {
  id: string;
  workflowName: string;
  revision: number;
  packageHash: string;
  executionHash: string;
  status: WorkflowRunStatus;
  workspace: string;
  inputs: JsonValue;
  outputs?: JsonValue;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: JsonValue;
}

export interface WorkflowStepRecord {
  runId: string;
  stepId: string;
  ordinal: number;
  uses: string;
  effect: WorkflowEffect;
  status: WorkflowStepStatus;
  attempts: number;
  output?: JsonValue;
  error?: JsonValue;
  startedAt?: number;
  endedAt?: number;
}

export interface WorkflowAttemptRecord {
  runId: string;
  stepId: string;
  attempt: number;
  status: WorkflowStepStatus;
  errorClass?: string;
  error?: JsonValue;
  startedAt: number;
  endedAt?: number;
}

export interface WorkflowModelAttemptRecord {
  runId: string;
  stepId: string;
  attempt: number;
  provider: string;
  requestedModel: string;
  servedModel?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  promptHash: string;
  constrained: boolean;
  startedAt: number;
  endedAt: number;
}

export interface WorkflowRunDetail {
  run: WorkflowRunRecord;
  steps: WorkflowStepRecord[];
  attempts: WorkflowAttemptRecord[];
  modelAttempts: WorkflowModelAttemptRecord[];
}

function parseJson(value: string | null): JsonValue | undefined {
  return value == null ? undefined : (JSON.parse(value) as JsonValue);
}

function serializable(value: ResolvedValue | undefined, label: string): string | null {
  if (!value) return null;
  if (value.provenance.sensitive) throw new Error(`${label} contains sensitive data`);
  return JSON.stringify(value.value);
}

export class WorkflowRunStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path, { create: true });
    this.initialize();
    this.reconcileInterrupted();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        package_hash TEXT NOT NULL,
        execution_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace TEXT NOT NULL,
        inputs_json TEXT NOT NULL,
        outputs_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_name_created
        ON workflow_runs(workflow_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS workflow_runs_status
        ON workflow_runs(status);

      CREATE TABLE IF NOT EXISTS workflow_steps (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        uses TEXT NOT NULL,
        effect TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        output_json TEXT,
        error_json TEXT,
        started_at INTEGER,
        ended_at INTEGER,
        PRIMARY KEY (run_id, step_id)
      );
      CREATE INDEX IF NOT EXISTS workflow_steps_run_ordinal
        ON workflow_steps(run_id, ordinal);

      CREATE TABLE IF NOT EXISTS workflow_attempts (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        error_class TEXT,
        error_json TEXT,
        PRIMARY KEY (run_id, step_id, attempt)
      );

      CREATE TABLE IF NOT EXISTS workflow_model_attempts (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        provider TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        served_model TEXT,
        finish_reason TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        prompt_hash TEXT NOT NULL,
        constrained INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id, attempt)
      );
    `);
  }

  private reconcileInterrupted(): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run(
        "UPDATE workflow_steps SET status = 'indeterminate', ended_at = ? WHERE status = 'running'",
        [now],
      );
      this.db.run(
        `UPDATE workflow_runs SET status = 'interrupted', ended_at = ?
         WHERE status IN ('preparing', 'awaiting_permission', 'running')`,
        [now],
      );
    })();
  }

  createRun(input: {
    id?: string;
    workflowName: string;
    revision: number;
    packageHash: string;
    executionHash: string;
    workspace: string;
    inputs: ResolvedValue;
    steps: Array<{ id: string; ordinal: number; uses: string; effect: WorkflowEffect }>;
  }): WorkflowRunRecord {
    const id = input.id ?? ulid();
    const now = Date.now();
    const inputsJson = serializable(input.inputs, "workflow inputs");
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO workflow_runs
         (id, workflow_name, revision, package_hash, execution_hash, status, workspace,
          inputs_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?, ?)`,
        [
          id,
          input.workflowName,
          input.revision,
          input.packageHash,
          input.executionHash,
          input.workspace,
          inputsJson,
          now,
        ],
      );
      for (const step of input.steps) {
        this.db.run(
          `INSERT INTO workflow_steps
           (run_id, step_id, ordinal, uses, effect, status)
           VALUES (?, ?, ?, ?, ?, 'pending')`,
          [id, step.id, step.ordinal, step.uses, step.effect],
        );
      }
    })();
    return this.getRun(id)!;
  }

  setRunStatus(
    id: string,
    status: WorkflowRunStatus,
    options: { outputs?: ResolvedValue; error?: JsonValue } = {},
  ): void {
    const outputs = serializable(options.outputs, "workflow outputs");
    const starts = status === "running";
    const ends = ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
    const now = Date.now();
    this.db.run(
      `UPDATE workflow_runs
       SET status = ?,
           outputs_json = COALESCE(?, outputs_json),
           error_json = COALESCE(?, error_json),
           started_at = CASE WHEN ? THEN COALESCE(started_at, ?) ELSE started_at END,
           ended_at = CASE WHEN ? THEN ? ELSE ended_at END
       WHERE id = ?`,
      [
        status,
        outputs,
        options.error ? JSON.stringify(options.error) : null,
        starts ? 1 : 0,
        now,
        ends ? 1 : 0,
        now,
        id,
      ],
    );
  }

  startStep(runId: string, stepId: string): number {
    const now = Date.now();
    return this.db.transaction(() => {
      const row = this.db
        .query<{ attempts: number }, [string, string]>(
          "SELECT attempts FROM workflow_steps WHERE run_id = ? AND step_id = ?",
        )
        .get(runId, stepId);
      if (!row) throw new Error(`unknown workflow step '${stepId}'`);
      const attempt = row.attempts + 1;
      this.db.run(
        `UPDATE workflow_steps
         SET status = 'running', attempts = ?, started_at = COALESCE(started_at, ?), ended_at = NULL
         WHERE run_id = ? AND step_id = ?`,
        [attempt, now, runId, stepId],
      );
      this.db.run(
        `INSERT INTO workflow_attempts
         (run_id, step_id, attempt, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
        [runId, stepId, attempt, now],
      );
      return attempt;
    })();
  }

  succeedStep(runId: string, stepId: string, attempt: number, output: ResolvedValue): void {
    const outputJson = serializable(output, `workflow step '${stepId}' output`);
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE workflow_attempts SET status = 'succeeded', ended_at = ?
         WHERE run_id = ? AND step_id = ? AND attempt = ?`,
        [now, runId, stepId, attempt],
      );
      this.db.run(
        `UPDATE workflow_steps
         SET status = 'succeeded', output_json = ?, error_json = NULL, ended_at = ?
         WHERE run_id = ? AND step_id = ?`,
        [outputJson, now, runId, stepId],
      );
    })();
  }

  failStep(
    runId: string,
    stepId: string,
    attempt: number,
    input: { errorClass: string; error: JsonValue; final: boolean },
  ): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE workflow_attempts
         SET status = 'failed', ended_at = ?, error_class = ?, error_json = ?
         WHERE run_id = ? AND step_id = ? AND attempt = ?`,
        [now, input.errorClass, JSON.stringify(input.error), runId, stepId, attempt],
      );
      this.db.run(
        `UPDATE workflow_steps SET status = ?, error_json = ?, ended_at = ?
         WHERE run_id = ? AND step_id = ?`,
        [input.final ? "failed" : "pending", JSON.stringify(input.error), now, runId, stepId],
      );
    })();
  }

  cancelStep(runId: string, stepId: string, attempt: number, error?: JsonValue): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE workflow_attempts SET status = 'cancelled', ended_at = ?, error_json = ?
         WHERE run_id = ? AND step_id = ? AND attempt = ?`,
        [now, error ? JSON.stringify(error) : null, runId, stepId, attempt],
      );
      this.db.run(
        `UPDATE workflow_steps SET status = 'cancelled', ended_at = ?, error_json = ?
         WHERE run_id = ? AND step_id = ?`,
        [now, error ? JSON.stringify(error) : null, runId, stepId],
      );
    })();
  }

  getRun(id: string): WorkflowRunRecord | undefined {
    const row = this.db
      .query<
        {
          id: string;
          workflow_name: string;
          revision: number;
          package_hash: string;
          execution_hash: string;
          status: WorkflowRunStatus;
          workspace: string;
          inputs_json: string;
          outputs_json: string | null;
          error_json: string | null;
          created_at: number;
          started_at: number | null;
          ended_at: number | null;
        },
        [string]
      >("SELECT * FROM workflow_runs WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      workflowName: row.workflow_name,
      revision: row.revision,
      packageHash: row.package_hash,
      executionHash: row.execution_hash,
      status: row.status,
      workspace: row.workspace,
      inputs: JSON.parse(row.inputs_json) as JsonValue,
      outputs: parseJson(row.outputs_json),
      error: parseJson(row.error_json),
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
    };
  }

  steps(runId: string): WorkflowStepRecord[] {
    const rows = this.db
      .query<
        {
          run_id: string;
          step_id: string;
          ordinal: number;
          uses: string;
          effect: WorkflowEffect;
          status: WorkflowStepStatus;
          attempts: number;
          output_json: string | null;
          error_json: string | null;
          started_at: number | null;
          ended_at: number | null;
        },
        [string]
      >("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY ordinal")
      .all(runId);
    return rows.map((row) => ({
      runId: row.run_id,
      stepId: row.step_id,
      ordinal: row.ordinal,
      uses: row.uses,
      effect: row.effect,
      status: row.status,
      attempts: row.attempts,
      output: parseJson(row.output_json),
      error: parseJson(row.error_json),
      startedAt: row.started_at ?? undefined,
      endedAt: row.ended_at ?? undefined,
    }));
  }

  attempts(runId: string): WorkflowAttemptRecord[] {
    const rows = this.db
      .query<
        {
          run_id: string;
          step_id: string;
          attempt: number;
          status: WorkflowStepStatus;
          started_at: number;
          ended_at: number | null;
          error_class: string | null;
          error_json: string | null;
        },
        [string]
      >("SELECT * FROM workflow_attempts WHERE run_id = ? ORDER BY step_id, attempt")
      .all(runId);
    return rows.map((row) => ({
      runId: row.run_id,
      stepId: row.step_id,
      attempt: row.attempt,
      status: row.status,
      errorClass: row.error_class ?? undefined,
      error: parseJson(row.error_json),
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
    }));
  }

  modelAttempts(runId: string): WorkflowModelAttemptRecord[] {
    const rows = this.db
      .query<
        {
          run_id: string;
          step_id: string;
          attempt: number;
          provider: string;
          requested_model: string;
          served_model: string | null;
          finish_reason: string | null;
          input_tokens: number | null;
          output_tokens: number | null;
          prompt_hash: string;
          constrained: number;
          started_at: number;
          ended_at: number;
        },
        [string]
      >("SELECT * FROM workflow_model_attempts WHERE run_id = ? ORDER BY step_id, attempt")
      .all(runId);
    return rows.map((row) => ({
      runId: row.run_id,
      stepId: row.step_id,
      attempt: row.attempt,
      provider: row.provider,
      requestedModel: row.requested_model,
      servedModel: row.served_model ?? undefined,
      finishReason: row.finish_reason ?? undefined,
      inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined,
      promptHash: row.prompt_hash,
      constrained: row.constrained === 1,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }));
  }

  history(input: { workflowName?: string; limit: number; offset: number }): WorkflowRunRecord[] {
    const limit = Math.min(100, Math.max(1, Math.floor(input.limit)));
    const offset = Math.max(0, Math.floor(input.offset));
    const rows = input.workflowName
      ? this.db
          .query<{ id: string }, [string, number, number]>(
            `SELECT id FROM workflow_runs
             WHERE workflow_name = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          )
          .all(input.workflowName, limit, offset)
      : this.db
          .query<{ id: string }, [number, number]>(
            "SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT ? OFFSET ?",
          )
          .all(limit, offset);
    return rows.flatMap((row) => {
      const run = this.getRun(row.id);
      return run ? [run] : [];
    });
  }

  recordModelAttempt(input: {
    runId: string;
    stepId: string;
    attempt: number;
    provider: string;
    requestedModel: string;
    servedModel?: string;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    promptHash: string;
    constrained: boolean;
    startedAt: number;
    endedAt: number;
  }): void {
    this.db.run(
      `INSERT INTO workflow_model_attempts
       (run_id, step_id, attempt, provider, requested_model, served_model, finish_reason,
        input_tokens, output_tokens, prompt_hash, constrained, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.stepId,
        input.attempt,
        input.provider,
        input.requestedModel,
        input.servedModel ?? null,
        input.finishReason ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.promptHash,
        input.constrained ? 1 : 0,
        input.startedAt,
        input.endedAt,
      ],
    );
  }

  close(): void {
    this.db.close();
  }
}
