import type { FindingSet } from "../evidence/contracts";
import type { JobArtifactChunk, JobEffect, JobStatus } from "../jobs/contracts";
import type { CleetusErrorCode } from "../lib/errors";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Result of reconciling a read against the per-session read cache. When `elided` is true,
 *  `content` is a short note and the file body is omitted (the model still has it in-window);
 *  otherwise `content` is the full body to send. */
export interface ReadReconcile {
  content: string;
  elided: boolean;
}

/** Per-session unchanged-re-read detector (#143, #153), driven by the runtime (which owns the
 *  frozen boundary index and the result's position in history). An unchanged re-read whose body
 *  is still in the live window is elided to a note; otherwise the full body is returned. */
export interface ReadCache {
  reconcile(
    path: string,
    content: string,
    resultIndex: number,
    verbatimStart: number,
    /** Current live tool-result cap in chars. A recorded body LARGER than this was truncated
     *  when sent, so it is not a verbatim copy — never elide against it. Default: no cap. */
    liveCap?: number,
  ): ReadReconcile;
}

export interface ToolContext {
  projectDir: string;
  abortSignal: AbortSignal;
  /** Active parent session for correlating nested strict workflow lifecycle events. */
  sessionId?: string;
  /** The session's current working list (last todo_write / todo_list_load), if any.
   * Supplied by the runtime; used by todo_list_save. */
  sessionTodos?: TodoItem[];
  /** True when the user has granted out-of-project writes this session (allow-global on an
   *  escaping write, or permissions disabled). Lets writing tools land outside the root. */
  allowOutsideProject?: boolean;
  /** Test seam for the secret-path read guard; defaults to os.homedir(). */
  homeDir?: string;
}

/** Security-relevant authority declared by an external operation before permission resolution.
 *  The permission layer may narrow or reject this authority; it never infers missing fields. */
export interface ToolAuthorization {
  type: "client_job";
  kind: string;
  effect: JobEffect;
  target?: string;
  limits: {
    timeoutMs: number;
    maxOutputBytes: number;
    maxArtifactBytes: number;
  };
}

export interface ToolResult {
  verification?: {
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    check: "test" | "build" | "typecheck" | "lint";
  };
  ok: boolean;
  output?: string;
  errorCode?: CleetusErrorCode;
  errorMessage?: string;
  /** Optional before/after snapshot for file-mutating tools, for diff rendering.
   *  `created` is true when the file did not exist before the write (so /rewind
   *  deletes it on revert rather than restoring `before`). */
  diff?: { path: string; before: string; after: string; created?: boolean };
  /** Current checklist for todo_write, for transcript rendering. */
  todos?: TodoItem[];
  /** Optional title for the todos block (e.g. a named list "groceries (project)"). */
  todosTitle?: string;
  /** A verifier could not run at all (no system browser, unreachable server): the result is
   *  inconclusive, not a failure — the runtime records it as unverified rather than a failed check. */
  verificationUnavailable?: boolean;
  /** The verifier actually observed the running app (e.g. render_check reached and inspected the
   *  rendered DOM), so a mismatch is a real defect rather than an environment gap. */
  verificationObserved?: boolean;
  /** The verifier exercised an interaction (clicked a control and checked the result), not just an
   *  initial render. */
  verificationInteraction?: boolean;
  verificationControl?: string;
  /** Validated structured output retained in the event log and bridged to ACP `rawOutput`.
   *  Text in `output` remains the fallback for clients that only render tool prose. */
  structuredContent?:
    | { type: "finding_set"; value: FindingSet }
    | { type: "job_status"; value: JobStatus }
    | { type: "job_artifact_chunk"; value: JobArtifactChunk };
}

export interface Tool {
  name: string;
  description: string;
  parameters: object; // JSON schema
  /** True for tools that change project files or run shell commands. Blocked in plan mode. */
  mutates?: boolean;
  /** Human-readable single-line summary used in permission prompts and the UI. */
  serialize(args: unknown): string;
  /** Structured external authority used by policy evaluation and permission prompts. */
  authorization?(args: unknown): ToolAuthorization | undefined;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
