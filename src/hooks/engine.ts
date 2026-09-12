import type { EventLog } from "../events/log";
import type { Sandbox } from "../sandbox/types";
import { matchHooks } from "./match";
import { runHook } from "./run";
import type {
  HookEngine,
  HookEntry,
  HookEvent,
  HookRun,
  PostHookOutcome,
  PostInput,
  PreHookOutcome,
  PreInput,
} from "./types";

interface Deps {
  sandbox: Sandbox;
  log: EventLog;
}

const MAX_REASON_DETAIL = 2000;

function truncateDetail(s: string): string {
  return s.length > MAX_REASON_DETAIL ? `${s.slice(0, MAX_REASON_DETAIL)}… (truncated)` : s;
}

/** Build a hook payload JSON. `args` is `unknown` (model-derived) — if it can't be serialized
 *  (BigInt / circular), degrade it to a placeholder so the engine never throws on payload build. */
function buildPayload(base: Record<string, unknown>): string {
  try {
    return JSON.stringify(base);
  } catch {
    return JSON.stringify({ ...base, args: "<unserializable>" });
  }
}

class HookEngineImpl implements HookEngine {
  constructor(
    private readonly entries: HookEntry[],
    private readonly deps: Deps,
  ) {}

  async runPreToolUse(input: PreInput): Promise<PreHookOutcome> {
    for (const entry of matchHooks(this.entries, "pre_tool_use", input.tool)) {
      const payload = buildPayload({
        event: "pre_tool_use",
        tool: input.tool,
        args: input.args,
        summary: input.summary,
      });
      const run = await runHook(entry, payload, this.deps.sandbox, input.signal);
      this.logRun("pre_tool_use", input.sessionId, input.tool, entry, run);
      if (run.errored || run.timedOut) {
        const why = run.timedOut ? "timeout" : "error";
        const detail = truncateDetail(run.stderr.trim());
        return { allow: false, reason: `hook ${why}${detail ? `: ${detail}` : ""}` };
      }
      if (run.exitCode !== 0) {
        const reason =
          truncateDetail(run.stdout.trim()) ||
          truncateDetail(run.stderr.trim()) ||
          "blocked by PreToolUse hook";
        return { allow: false, reason };
      }
    }
    return { allow: true };
  }

  async runPostToolUse(input: PostInput): Promise<PostHookOutcome> {
    const parts: string[] = [];
    for (const entry of matchHooks(this.entries, "post_tool_use", input.tool)) {
      const payload = buildPayload({
        event: "post_tool_use",
        tool: input.tool,
        args: input.args,
        summary: input.summary,
        result: input.result,
      });
      const run = await runHook(entry, payload, this.deps.sandbox, input.signal);
      this.logRun("post_tool_use", input.sessionId, input.tool, entry, run);
      if (run.errored || run.timedOut) continue; // post is fail-soft: no feedback from a broken hook
      const out = run.stdout.trim();
      if (out) parts.push(out);
    }
    return parts.length > 0 ? { feedback: parts.join("\n\n") } : {};
  }

  private logRun(
    event: HookEvent,
    sessionId: string,
    tool: string,
    entry: HookEntry,
    run: HookRun,
  ): void {
    this.deps.log.append({
      sessionId,
      type: "hook_run",
      payload: {
        event,
        tool,
        command: entry.command,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        errored: run.errored,
      },
    });
  }
}

/** Build a hook engine, or undefined when there are no hooks (so the runtime stays on its
 *  exact current path). */
export function buildHookEngine(entries: HookEntry[], deps: Deps): HookEngine | undefined {
  if (entries.length === 0) return undefined;
  return new HookEngineImpl(entries, deps);
}
