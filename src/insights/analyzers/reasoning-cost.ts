import type { TaskClass } from "../../agent/coding-task";
import type { ModelCallSummary, Trajectory } from "../trajectory";

/** Rough chars-per-token used to turn reasoning text length into a token estimate. No provider
 * reports reasoning tokens separately (they are folded into `usage.output`), so this is the best
 * available proxy; the report labels every derived number as an estimate. */
export const REASONING_CHARS_PER_TOKEN = 4;

export interface ReasoningBucket {
  calls: number;
  /** Calls whose terminal `reasoning` event carried any text. */
  callsWithReasoning: number;
  reasoningChars: number;
  /** `reasoningChars / REASONING_CHARS_PER_TOKEN`, rounded. */
  estReasoningTokens: number;
  /** Sum of `usage.output` over calls that reported it; null when none did. */
  outputTokens: number | null;
  /** `estReasoningTokens / outputTokens`, clamped to [0, 1]; null when outputTokens is null. */
  reasoningShare: number | null;
}

export interface ReasoningByClass extends ReasoningBucket {
  turns: number;
  okTurns: number;
  tiers: { small: ReasoningBucket; large: ReasoningBucket; untiered: ReasoningBucket };
}

export interface ReasoningCost {
  byTaskClass: Record<TaskClass, ReasoningByClass>;
  /** True when at least one call in the input carried reasoning text — the signal that the
   * report section has anything to say (most models emit no reasoning channel at all). */
  hasReasoning: boolean;
}

const TASK_CLASSES: TaskClass[] = [
  "conversation",
  "retrieval",
  "artifact",
  "focused_code",
  "broad_code",
];

interface Acc {
  calls: number;
  callsWithReasoning: number;
  reasoningChars: number;
  outputTokens: number;
  sawOutput: boolean;
}

const emptyAcc = (): Acc => ({
  calls: 0,
  callsWithReasoning: 0,
  reasoningChars: 0,
  outputTokens: 0,
  sawOutput: false,
});

function addCall(acc: Acc, m: ModelCallSummary): void {
  acc.calls++;
  if (m.reasoningChars > 0) acc.callsWithReasoning++;
  acc.reasoningChars += m.reasoningChars;
  if (m.usage?.output != null) {
    acc.sawOutput = true;
    acc.outputTokens += m.usage.output;
  }
}

function finalize(acc: Acc): ReasoningBucket {
  const estReasoningTokens = Math.round(acc.reasoningChars / REASONING_CHARS_PER_TOKEN);
  const outputTokens = acc.sawOutput ? acc.outputTokens : null;
  const reasoningShare =
    outputTokens === null || outputTokens === 0
      ? null
      : Math.min(1, estReasoningTokens / outputTokens);
  return {
    calls: acc.calls,
    callsWithReasoning: acc.callsWithReasoning,
    reasoningChars: acc.reasoningChars,
    estReasoningTokens,
    outputTokens,
    reasoningShare,
  };
}

export function analyzeReasoningCost(trajectories: Trajectory[]): ReasoningCost {
  const accs = Object.fromEntries(
    TASK_CLASSES.map((c) => [
      c,
      {
        all: emptyAcc(),
        small: emptyAcc(),
        large: emptyAcc(),
        untiered: emptyAcc(),
        turns: 0,
        okTurns: 0,
      },
    ]),
  ) as Record<
    TaskClass,
    { all: Acc; small: Acc; large: Acc; untiered: Acc; turns: number; okTurns: number }
  >;
  let hasReasoning = false;

  for (const t of trajectories) {
    const a = accs[t.taskClass];
    a.turns++;
    if (t.outcome === "ok") a.okTurns++;
    for (const m of t.modelCalls) {
      if (m.reasoningChars > 0) hasReasoning = true;
      addCall(a.all, m);
      addCall(m.tier === "small" ? a.small : m.tier === "large" ? a.large : a.untiered, m);
    }
  }

  const byTaskClass = Object.fromEntries(
    TASK_CLASSES.map((c) => {
      const a = accs[c];
      return [
        c,
        {
          ...finalize(a.all),
          turns: a.turns,
          okTurns: a.okTurns,
          tiers: {
            small: finalize(a.small),
            large: finalize(a.large),
            untiered: finalize(a.untiered),
          },
        },
      ];
    }),
  ) as Record<TaskClass, ReasoningByClass>;

  return { byTaskClass, hasReasoning };
}
