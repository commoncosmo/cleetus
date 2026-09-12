export type HookEvent = "pre_tool_use" | "post_tool_use";

export interface HookEntry {
  event: HookEvent;
  /** Regex tested against the tool name; omitted/"" = all tools. */
  matcher?: string;
  command: string;
  /** Per-hook kill timeout; default applied in the runner. */
  timeoutMs?: number;
}

/** A single hook execution's raw outcome. */
export interface HookRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the command could not run (spawn failure / sandbox unavailable). */
  errored: boolean;
}

export interface HookToolResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface PreHookOutcome {
  allow: boolean;
  reason?: string;
}
export interface PostHookOutcome {
  feedback?: string;
}

export interface PreInput {
  sessionId: string;
  tool: string;
  args: unknown;
  summary: string;
  signal: AbortSignal;
}
export interface PostInput extends PreInput {
  result: HookToolResult;
}

/** The runtime depends on this interface (so tests can supply a fake engine). */
export interface HookEngine {
  runPreToolUse(input: PreInput): Promise<PreHookOutcome>;
  runPostToolUse(input: PostInput): Promise<PostHookOutcome>;
}
