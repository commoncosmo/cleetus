export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export type WorkflowScope = "project" | "global";
export type WorkflowSource = WorkflowScope;
export type WorkflowEffect = "read-only" | "idempotent" | "side-effecting";
export type WorkflowRunStatus =
  | "preparing"
  | "awaiting_permission"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "indeterminate";

export type WorkflowRetryClass =
  | "timeout"
  | "connection_error"
  | "http_429"
  | "http_5xx"
  | "provider_error";

export interface WorkflowValidationIssue {
  path: string;
  message: string;
  keyword?: string;
}

export interface WorkflowRetryPolicy {
  attempts: number;
  backoff: {
    initialMs: number;
    multiplier: number;
    maximumMs: number;
  };
  when: WorkflowRetryClass[];
}

export interface WorkflowNetworkPermission {
  host: string;
  methods: string[];
}

export interface WorkflowCommandPermission {
  program: string;
  argsPrefix?: string[];
}

export interface WorkflowFilesystemPermission {
  read: string[];
  write: string[];
}

export interface WorkflowPermissions {
  network: WorkflowNetworkPermission[];
  commands: WorkflowCommandPermission[];
  filesystem: WorkflowFilesystemPermission;
  model: boolean;
}

export interface WorkflowResultEnvelope {
  run_id: string;
  workflow: string;
  revision: number;
  execution_hash: string;
  status: WorkflowRunStatus;
  outputs?: Record<string, JsonValue>;
  error?: { code: string; message: string };
}
