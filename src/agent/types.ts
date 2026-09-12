import type { Decision } from "../permission/types";
import type { ToolResult } from "../tools/types";

export interface RunTurnResult {
  assistantText: string;
  toolCalls: number;
  /** Allowed tool executions that completed successfully this turn. Policy/permission denials
   *  and cached verification results are excluded. */
  successfulToolCalls: number;
  /** Allowed tool executions that failed this turn. Policy/permission denials and cached
   *  verification results are excluded so this reflects unsuccessful work, not guard friction. */
  failedToolCalls: number;
  /** Successful executions whose structured retrieval result was objectively empty or
   *  metadata-only. Kept separate from transport/tool failures. */
  unproductiveToolCalls?: number;
  /** Count of structured-write-tool calls (write_file/edit_file/multi_edit/apply_patch) that
   *  returned a diff this turn — i.e. writes that landed. */
  successfulEdits: number;
  /** Count of structured-write-tool calls that returned ok:false this turn — writes that were
   *  blocked (e.g. out-of-tree denial) or otherwise failed. */
  failedWrites: number;
  /** Set when the turn stopped for a reason the caller may need to branch on. Absent only on
   *  normal completion. */
  stoppedReason?:
    | "loop_limit"
    | "token_budget"
    | "time_budget"
    | "thrash"
    | "hidden_tools"
    | "no_progress"
    | "premature_completion"
    | "stream_watchdog"
    | "permission_error"
    | "provider_error"
    | "cancelled";
  /** Project-relative paths of files this turn wrote/edited (from each landed structured write).
   *  Deduped; reads excluded. `[]` when the turn wrote nothing. */
  editedPaths: string[];
  /** Latest result for each explicit verification command run during this turn. Failed entries
   *  remain unresolved until the same command later succeeds; orchestration uses these facts
   *  instead of trusting a worker's prose claim that a failing suite is unrelated. */
  verificationResults?: VerificationResult[];
  /** Deterministic bounded handoff for a continuation/recovery worker. */
  progressSummary?: string;
  /** Number of progress-sensitive cost extensions granted during this turn. */
  budgetExtensions?: number;
}

export interface VerificationResult {
  execution?: ToolResult["verification"];
  control?: string;
  key: string;
  command: string;
  ok: boolean;
  detail: string;
  /** What this command directly demonstrated. A launched process does not prove that a browser
   * rendered the changed UI. Older/untyped results remain supported through command inference. */
  evidence?: "quality" | "test" | "launch" | "render";
  /** Broad, repository-wide suites are integration evidence. Leaf workers may report them, but
   *  they are adjudicated by the final acceptance pass rather than failing every isolated task. */
  scope?: "focused" | "full";
  /** True only for a command explicitly marked as running in an isolated starting revision. */
  baseline?: boolean;
  /** Stable failing test/check identities parsed from command output. */
  failureIds?: string[];
}

export type ResolvePermission = (req: {
  /** Provider-assigned ID for the tool call being authorized. ACP clients require this to
   *  correlate the permission prompt with the eventual tool-call updates. */
  toolCallId?: string;
  tool: string;
  args: unknown;
  argsSummary: string;
}) => Promise<Decision>;
