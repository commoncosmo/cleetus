export type WorkflowReviewReply =
  | { kind: "activate" }
  | { kind: "cancel" }
  | { kind: "run_after_activation" }
  | { kind: "revise"; text: string };

export function resolveWorkflowReviewReply(input: string): WorkflowReviewReply {
  const value = input.trim();
  if (/^(?:yes|agreed|accept|accepted|activate|save|looks good|approved)[.!]?$/iu.test(value)) {
    return { kind: "activate" };
  }
  if (/^(?:cancel|stop|never mind|nevermind)[.!]?$/iu.test(value)) return { kind: "cancel" };
  if (/^(?:run|dry-run|dry run)(?:\s+it)?[.!]?$/iu.test(value)) {
    return { kind: "run_after_activation" };
  }
  return { kind: "revise", text: value };
}
