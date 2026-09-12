export interface StatefulControllerRisk {
  message: string;
  evidence: string;
}

const COPY_VERB =
  /\b(?:cop(?:y|ies|ied|ying)|re-cop(?:y|ies|ied|ying)|replicat(?:e|es|ed|ing)|duplicat(?:e|es|ed|ing)|mirror(?:s|ed|ing)?)\b/;
const STATEFUL_TARGET =
  /\b(?:inline\s+state|state\s+shape|state\s+block|stateful|hooks?|handlers?|controller|runtime\s+logic|submission\s+logic|permission\s+logic)\b/;

function isNegatedOrRejected(line: string): boolean {
  const negativeBeforeCopy =
    /\b(?:do\s+not|don't|doesn't|didn't|cannot|can't|never|neither|must\s+not|should\s+not|would\s+not|won't|avoid(?:s|ed|ing)?|prevent(?:s|ed|ing)?|without|nothing|none|no|zero)\b.{0,100}\b(?:cop|re-cop|replicat|duplicat|mirror)/;
  const negatedPassive =
    /\b(?:state|stateful|hooks?|handlers?|controller|logic)\b.{0,80}\b(?:is|are|gets?|will\s+be|should\s+be|would\s+be)\s+(?:not|never)\s+(?:cop|re-cop|replicat|duplicat|mirror)/;
  const namedAntiPattern =
    /\b(?:cop|re-cop|replicat|duplicat|mirror)\w*\b.{0,120}\b(?:would(?:\s+be)?|creates?|causes?|leads?\s+to|risks?)\b.{0,60}\b(?:behavior\s+fork|fork|drift|anti-pattern|problem|risk)/;
  const rejectedHeading =
    /\b(?:why\s+not|rejected|do\s+not\s+use|instead\s+of)\b.{0,120}\b(?:cop|re-cop|replicat|duplicat|mirror)/;
  return (
    negativeBeforeCopy.test(line) ||
    negatedPassive.test(line) ||
    namedAntiPattern.test(line) ||
    rejectedHeading.test(line)
  );
}

function isActiveDesignCommitment(line: string): boolean {
  const imperative =
    /^(?:#{1,6}\s*)?(?:(?:step|task)\s*\d+\s*[:.)-]?\s*|\d+[.)]\s*|[-*]\s*)?(?:cop|re-cop|replicat|duplicat|mirror)\w*\b/;
  const namedSubject =
    /\b(?:alt\w*|sibling|second|new|each|both|skin|presentation|component|renderer|layout|approach|design|plan|task|step)\b.{0,100}\b(?:cop|re-cop|replicat|duplicat|mirror)\w*\b/;
  const futureDirective =
    /\b(?:we\s+will|we'll|will|should|must|plan\s+to|intend\s+to)\b.{0,80}\b(?:cop|re-cop|replicat|duplicat|mirror)\w*\b/;
  const passiveCommitment =
    /\b(?:state|stateful|hooks?|handlers?|controller|logic)\b.{0,80}\b(?:will\s+be|should\s+be|are\s+to\s+be)\s+(?:cop|re-cop|replicat|duplicat|mirror)\w*\b/;
  return (
    imperative.test(line) ||
    namedSubject.test(line) ||
    futureDirective.test(line) ||
    passiveCommitment.test(line)
  );
}

const REJECTED_SECTION_HEADING =
  /\b(?:does?\s+not\s+do|do\s+not\s+do|will\s+not\s+do|won't\s+do|out\s+of\s+scope|non-?goals?|rejected\s+alternatives?|prohibited|forbidden|must\s+not)\b/i;

/** Return prose candidates while retaining the polarity supplied by Markdown headings. A bullet
 * such as "Copy the controller" is an active instruction under `## Steps`, but the same words
 * under `## What this plan deliberately does NOT do` describe a prohibition. The old line-only
 * scan discarded that heading context and rejected sound plans. */
function activePlanCandidates(text: string): string[] {
  const candidates: string[] = [];
  let rejectedSectionLevel: number | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const level = heading[1]!.length;
      if (rejectedSectionLevel !== null && level <= rejectedSectionLevel) {
        rejectedSectionLevel = null;
      }
      if (REJECTED_SECTION_HEADING.test(heading[2]!)) {
        rejectedSectionLevel = level;
        continue;
      }
      if (rejectedSectionLevel !== null) continue;
    } else if (rejectedSectionLevel !== null) {
      continue;
    }

    candidates.push(
      ...line
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean),
    );
  }
  return candidates;
}

/** Detect an active instruction to copy stateful behavior. Explanations of a rejected alternative,
 * hypotheticals, and explicit negations are evidence of architectural care, not violations. */
export function findCopiedStatefulControllerRisk(text: string): StatefulControllerRisk | null {
  const candidates = activePlanCandidates(text);

  for (const line of candidates) {
    // "mascot, copy, and badge" lists page content. Here copy is a noun, not an
    // instruction to duplicate the controller mentioned elsewhere in the sentence (ccweb3).
    const lower = line.toLowerCase().replace(/,\s*copy\s*,/g, ", prose,");
    if (!COPY_VERB.test(lower) || !STATEFUL_TARGET.test(lower)) continue;
    if (isNegatedOrRejected(lower) || !isActiveDesignCommitment(lower)) continue;
    return {
      message:
        "The proposed design actively copies stateful hooks, handlers, or controller logic. " +
        "That is a behavior fork even when both components share the same props.",
      evidence: line.slice(0, 320),
    };
  }
  return null;
}

/** Backward-compatible string form used by spec handoff and plan approval. */
export function copiedStatefulControllerRisk(text: string): string | null {
  const risk = findCopiedStatefulControllerRisk(text);
  if (!risk) return null;
  return `${risk.message} Offending plan text: “${risk.evidence}” Establish one shared controller/composition seam before the presentations diverge.`;
}

/** One bounded repair-choice turn after a genuine architecture rejection. The immediately prior
 * assistant message already contains the full plan, so repeating it here would waste context. */
export function architectureResolutionPrompt(risk: string): string {
  return `The architecture guard blocked the implementation plan for this specific reason:\n${risk}\n\nDo not emit another implementation plan yet. Instead, present 2-3 mutually exclusive, repository-grounded ways to repair this seam. For each option, state what remains shared, what moves, and the main tradeoff. Recommend one option and explain why. End by asking the user to choose an option. This is a bounded decision turn, not a new repository investigation.`;
}
