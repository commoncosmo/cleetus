import { relative, resolve, sep } from "node:path";
import type { EditorLaunchResult } from "./launch";
import { parseEditorWords } from "./words";

export type EditorAuditIntegration =
  | "edit"
  | "workflow"
  | "skill"
  | "config"
  | "permissions"
  | "instructions"
  | "spec"
  | "plan";

export type EditorTargetScope = "project" | "outside_project" | "mixed";

export interface EditorAuditPayload {
  kind: "editor_audit";
  visibility: "verbose";
  phase: "started" | "authorization" | "finished";
  integration: EditorAuditIntegration;
  status?: "allowed" | "denied" | "succeeded" | "failed";
  editor?: string;
  target_count?: number;
  target_scope?: EditorTargetScope;
  outside_project_requested?: boolean;
  create_requested?: true;
  duration_ms?: number;
  failure_code?: EditorFailureCode;
}

export type EditorFailureCode =
  | "editor_not_configured"
  | "unsafe_editor_configuration"
  | "invalid_request"
  | "target_missing"
  | "target_exists"
  | "creation_failed"
  | "outside_project_confirmation_required"
  | "outside_project_authorization_unavailable"
  | "outside_project_denied"
  | "launch_failed"
  | "nonzero_exit"
  | "unknown";

export interface EditorAuditLaunchRequest {
  args?: string;
  targets?: string[];
  confirmOutsideProject?: boolean;
  create?: boolean;
}

interface OutsideProjectAuthorizationRequest {
  editor: string;
  targets: string[];
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function editorExecutableLabel(executable: string): string | undefined {
  const label = executable.split(/[\\/]/u).filter(Boolean).at(-1)?.trim();
  return label || undefined;
}

export function editorTargetScope(cwd: string, targets: string[]): EditorTargetScope | undefined {
  if (targets.length === 0) return undefined;
  const root = resolve(cwd);
  const projectCount = targets.filter((target) => inside(root, resolve(target))).length;
  if (projectCount === targets.length) return "project";
  if (projectCount === 0) return "outside_project";
  return "mixed";
}

export function editorFailureCode(error: unknown): EditorFailureCode {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("$EDITOR is not set") ||
    message.includes("$EDITOR and $VISUAL are not set") ||
    message.includes("does not contain an executable")
  ) {
    return "editor_not_configured";
  }
  if (message.includes("shell command interpreter")) return "unsafe_editor_configuration";
  if (
    message.includes("cannot combine") ||
    message.includes("must not be empty") ||
    message.includes("requires exactly one")
  ) {
    return "invalid_request";
  }
  if (message.includes("edit target does not exist")) return "target_missing";
  if (message.includes("edit target already exists")) return "target_exists";
  if (
    message.includes("could not create edit target") ||
    message.includes("edit target parent") ||
    message.includes("edit target must be a file inside the project")
  ) {
    return "creation_failed";
  }
  if (message.includes("use /edit --outside-project")) {
    return "outside_project_confirmation_required";
  }
  if (message.includes("outside-project editor authorization is unavailable")) {
    return "outside_project_authorization_unavailable";
  }
  if (message.includes("outside-project edit cancelled")) return "outside_project_denied";
  if (message.includes("could not launch editor")) return "launch_failed";
  if (message.includes("exited with status")) return "nonzero_exit";
  return "unknown";
}

function requestedTargetCount(request: EditorAuditLaunchRequest): number | undefined {
  if (request.targets) return request.targets.length || 1;
  try {
    const parsed = parseEditorWords(request.args ?? "", "/edit arguments");
    if (parsed[0] === "--") parsed.shift();
    return parsed.length || 1;
  } catch {
    return undefined;
  }
}

function duration(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

/**
 * Audit one modal editor handoff without retaining paths, command arguments,
 * workflow/skill names, or raw errors.
 */
export async function runAuditedEditorHandoff(input: {
  integration: EditorAuditIntegration;
  request: EditorAuditLaunchRequest;
  cwd: string;
  launch: (
    request: EditorAuditLaunchRequest,
    cwd: string,
    authorizeOutsideProject: (request: OutsideProjectAuthorizationRequest) => Promise<boolean>,
  ) => Promise<EditorLaunchResult>;
  authorizeOutsideProject: (request: OutsideProjectAuthorizationRequest) => Promise<boolean>;
  record: (payload: EditorAuditPayload) => void;
  now?: () => number;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  input.record({
    kind: "editor_audit",
    visibility: "verbose",
    phase: "started",
    integration: input.integration,
    target_count: requestedTargetCount(input.request),
    outside_project_requested: Boolean(input.request.confirmOutsideProject),
    ...(input.request.create ? { create_requested: true as const } : {}),
  });

  try {
    const result = await input.launch(input.request, input.cwd, async (request) => {
      const authorizationStartedAt = now();
      const allowed = await input.authorizeOutsideProject(request);
      input.record({
        kind: "editor_audit",
        visibility: "verbose",
        phase: "authorization",
        integration: input.integration,
        status: allowed ? "allowed" : "denied",
        editor: editorExecutableLabel(request.editor),
        target_count: request.targets.length,
        target_scope: "outside_project",
        duration_ms: duration(authorizationStartedAt, now),
      });
      return allowed;
    });
    input.record({
      kind: "editor_audit",
      visibility: "verbose",
      phase: "finished",
      integration: input.integration,
      status: "succeeded",
      editor: editorExecutableLabel(result.argv[0] ?? ""),
      target_count: result.targets.length,
      target_scope: editorTargetScope(input.cwd, result.targets),
      duration_ms: duration(startedAt, now),
    });
  } catch (error) {
    input.record({
      kind: "editor_audit",
      visibility: "verbose",
      phase: "finished",
      integration: input.integration,
      status: "failed",
      target_count: requestedTargetCount(input.request),
      outside_project_requested: Boolean(input.request.confirmOutsideProject),
      ...(input.request.create ? { create_requested: true as const } : {}),
      duration_ms: duration(startedAt, now),
      failure_code: editorFailureCode(error),
    });
    throw error;
  }
}
