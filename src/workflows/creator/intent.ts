export interface WorkflowCreationIntent {
  name?: string;
}

const WORKFLOW_NAME = "[a-z0-9]+(?:-[a-z0-9]+)*";

function normalizeQuotes(value: string): string {
  return value.replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

function extractName(match: RegExpExecArray): string | undefined {
  return (match[1] ?? match[2] ?? match[3])?.toLowerCase();
}

export function detectWorkflowCreationIntent(input: string): WorkflowCreationIntent | null {
  const trimmed = normalizeQuotes(input.trim());
  const quotedName = `(?:"(${WORKFLOW_NAME})"|'(${WORKFLOW_NAME})'|(${WORKFLOW_NAME}))`;
  const slash = new RegExp(`^/workflow\\s+create(?:\\s+${quotedName})?$`, "iu").exec(trimmed);
  if (slash) return { name: extractName(slash) };
  const natural = new RegExp(
    `^(?:i\\s+want\\s+to\\s+create|create)\\s+a\\s+workflow(?:\\s+(?:called|named)\\s+${quotedName})?[.!]?$`,
    "iu",
  ).exec(trimmed);
  return natural ? { name: extractName(natural) } : null;
}
