import type { Message } from "../providers/types";
import { stripSystemReminders } from "../skills/compose";

/** Host-generated workflow instructions are not new product requirements. */
export function isWorkflowPrompt(text: string): boolean {
  return /^(?:Implement step \d+ of \d+|Review the already-approved specification|Read the approved spec|Apply this one bounded revision pass|The plan is approved|Implement the approved spec)/i.test(
    text.trim(),
  );
}

/** Preserve the user's wording independently of model-authored specs. Kept outside the lossy
 * digest. A new /spec starts a new contract; recent corrections remain authoritative. */
export function originalUserRequests(messages: Message[]): string {
  const requests = messages
    .filter((m) => m.role === "user")
    .filter((m) => m.userRequest !== null)
    .map((m) => ({
      text: stripSystemReminders(m.userRequest ?? m.content).trim(),
      authored: m.userRequest !== undefined,
    }))
    .filter(({ text, authored }) => text && (authored || !isWorkflowPrompt(text)))
    .map(({ text }) => text);
  let specStart = -1;
  requests.forEach((text, i) => {
    if (/^\/spec\b/i.test(text)) specStart = i;
  });
  const relevant = specStart >= 0 ? requests.slice(specStart) : requests.slice(-1);
  const text = relevant.join("\n\n");
  return text.length <= 8000
    ? text
    : `${relevant[0]!.slice(0, 1000)}\n[older dialogue omitted]\n${text.slice(-6900)}`;
}

export function acceptanceReminder(requests: string): string {
  return requests
    ? `<system-reminder>Original user requirements and corrections (verbatim; later corrections take precedence). Check the spec, implementation, and tests against these words. A generated spec must not reverse them. External API assumptions require documentation or an observed response fixture before writing mocks.\n\n${requests}</system-reminder>`
    : "";
}
