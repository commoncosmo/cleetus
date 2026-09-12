import type { Tool, ToolContext, ToolResult } from "./types";

interface Args {
  reason: string;
}

/** A signal-only tool: it has no side effects on the project. Calling it records, in this
 * turn's history, that the current (small) tier judged the task beyond it — the
 * router's smart-mode evaluation (see `Router.supportsEscalationRequest`) detects the call and
 * hands the rest of the turn to the large tier, exactly like an observed tool failure or a
 * stalled retrieval. Only ever advertised in smart mode with tiers configured; calling it
 * outside that context is harmless but has no routing effect. */
export class RequestEscalationTool implements Tool {
  name = "request_escalation";
  /** No side effects on project files — not gated as a mutating tool. */
  mutates?: boolean;
  description =
    "Request handoff to a stronger model for the rest of this turn. Use this only when you've " +
    "judged the task exceeds your own capability — subtle multi-file reasoning, an ambiguous " +
    "requirement that needs judgment, or a fix you're not confident is correct. State briefly " +
    "why. This has no effect on project files.";
  parameters = {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "A brief explanation of why this task needs a stronger model",
      },
    },
    required: ["reason"],
  };

  serialize(args: unknown): string {
    const { reason } = args as Args;
    return `request_escalation: ${reason}`;
  }

  async run(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { reason } = args as Args;
    return {
      ok: true,
      output: `Escalation requested (${reason}). The next model call will use the stronger model.`,
    };
  }
}
