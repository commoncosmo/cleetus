import type { RunTurnResult } from "../agent/types";

const REPEATED_UNSUCCESSFUL_ATTEMPTS = 2;
const MINIMUM_EXECUTED_TOOLS = 4;

/**
 * Suggest learning only after a completed turn demonstrated recovery from repeated real tool
 * failures or objectively empty structured retrievals. A single transient miss is deliberately
 * insufficient, and the suggestion never writes anything by itself.
 */
export function shouldSuggestPlaybook(
  result: Pick<
    RunTurnResult,
    "stoppedReason" | "successfulToolCalls" | "failedToolCalls" | "unproductiveToolCalls"
  >,
): boolean {
  const unsuccessful = result.failedToolCalls + (result.unproductiveToolCalls ?? 0);
  const executed = result.successfulToolCalls + result.failedToolCalls;
  return (
    result.stoppedReason === undefined &&
    unsuccessful >= REPEATED_UNSUCCESSFUL_ATTEMPTS &&
    result.successfulToolCalls > 0 &&
    executed >= MINIMUM_EXECUTED_TOOLS
  );
}

export function playbookSuggestionText(
  result: Pick<RunTurnResult, "failedToolCalls" | "unproductiveToolCalls">,
): string {
  const unsuccessful = result.failedToolCalls + (result.unproductiveToolCalls ?? 0);
  return `This turn recovered after ${unsuccessful} unsuccessful tool attempts. Run \`/learn\` to draft a reusable playbook from the approach that worked.`;
}
