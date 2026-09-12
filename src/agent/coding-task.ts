/** Polite/filler prefixes stripped before checking the leading verb. Longest first. */
const PREFIXES = [
  "i want you to",
  "i'd like you to",
  "go ahead and",
  "could you",
  "would you",
  "can you",
  "please",
  "let's",
  "lets",
];

/** Imperative verbs that, when leading, mark a request to do code work.
 *  Build/create verbs PLUS modify-existing verbs (the latter were missing before). */
const VERBS = new Set([
  // build / create
  "build",
  "create",
  "implement",
  "add",
  "write",
  "make",
  "scaffold",
  "generate",
  "develop",
  "design",
  "setup",
  // modify / maintain
  "fix",
  "refactor",
  "update",
  "change",
  "debug",
  "optimize",
  "optimise",
  "rewrite",
  "rename",
  "remove",
  "delete",
  "migrate",
  "improve",
]);

function stripLeadingPrefix(s: string): string {
  for (const p of PREFIXES) {
    if (s === p || (s.startsWith(p) && /\s/.test(s.charAt(p.length)))) {
      return s.slice(p.length).trim();
    }
  }
  return s;
}

/**
 * True when a message reads as an imperative request to do code work. Pure.
 *
 * Triggers: a leading build/modify verb (after stripping one politeness prefix), OR the
 * presence of a fenced code block. The imperative-leading-verb requirement is the guardrail
 * that keeps questions ("how would I refactor this?", "what's wrong with X?") out — they don't
 * start with a bare verb. A bare file-path mention is intentionally NOT a trigger (questions
 * routinely name files); paste a code fence or phrase it as a command to engage.
 */
export function isCodingTask(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.includes("```")) return true;
  const s = stripLeadingPrefix(trimmed);
  if (!s) return false;
  // Two-word "set up ..." (one-word "setup" is in VERBS).
  if (/^set up(\s|$)/.test(s)) return true;
  const first = s.match(/^[a-z']+/)?.[0] ?? "";
  return VERBS.has(first);
}

/** Build verbs that, with a software noun, mark a request to build substantial software. */
const BUILD_VERB = "(?:build|create|implement|develop|scaffold|make)";
/** 0–2 arbitrary lowercase words bridging the verb and noun (generalized to allow domain words like brand names). */
const FILLER = "(?:(?:[a-z]+\\s+))?(?:(?:[a-z]+\\s+))?";
/** Substantial-software nouns. Multi-word entries first so the alternation prefers them. */
const SOFTWARE_NOUN =
  "(?:web app|web-app|webapp|web page|web-page|webpage|rest api|command-line tool|app|application|website|site|api|endpoint|server|backend|frontend|service|microservice|system|platform|project|cli|tool|dashboard|pipeline|bot|game|library|sdk|package|extension|plugin|module|framework|database|schema|migration)";
/** Content/document nouns that, when immediately following a software noun, indicate a planning or
 *  documentation request rather than a build request (e.g. "project plan", "migration strategy"). */
const CONTENT_NOUN =
  "(?:plans?|strategy|strategies|documents?|docs?|diagrams?|specs?|specification|designs?|ideas?|overview|reports?|summary|summaries|architecture|structure|guide|outline|proposal|roadmap|mockup|wireframe|lists?|tables?)";

const BUILD_VERB_RE = new RegExp(`\\b${BUILD_VERB}\\b`);
const BUILD_NOUN_RE = new RegExp(
  `\\b${BUILD_VERB}\\b\\s+${FILLER}${SOFTWARE_NOUN}\\b(?!\\s+${CONTENT_NOUN}\\b)`,
);

/**
 * True only when a message is an explicit imperative request to build substantial software.
 * Composed with `isCodingTask` (which requires a leading imperative verb after one politeness
 * prefix) so questions like "what's the best way to build an app?" are excluded for free. Then
 * requires a build verb governing a software noun, OR a code fence plus a build verb. A leading
 * verb alone (e.g. "create a list") is deliberately NOT enough — that's the whole point. Pure.
 */
export function isExplicitBuild(input: string): boolean {
  if (!isCodingTask(input)) return false; // imperative coding request only — excludes questions
  const text = input.trim().toLowerCase();
  if (text.includes("```")) return BUILD_VERB_RE.test(text); // paste-and-extend build
  return BUILD_NOUN_RE.test(text);
}

export type TaskClass = "conversation" | "retrieval" | "artifact" | "focused_code" | "broad_code";

const BROAD_CODE_RE =
  /\b(?:architecture|architectural|repository-wide|repo-wide|codebase-wide|across the (?:repository|repo|codebase|application|project)|end-to-end|multiple (?:modules|packages|services))\b/i;
const ARTIFACT_RE =
  /\b(?:json (?:file|document|output|data)|csv|data file|markdown|readme|report|spreadsheet|text file)\b|\bas (?:a )?json\b|\.json\b/i;
const ARTIFACT_OUTPUT_RE =
  /^(?:save|export|write|generate|create|make|update)\s+(?:(?:the|those|these|an?|my|your)\s+)?(?:(?:results?|output|data|forecast)\s+)?(?:to\s+|as\s+)?(?:an?\s+)?(?:json (?:file|document|output|data)|csv|data file|markdown|readme|report|spreadsheet|text file)\b/i;
const RETRIEVAL_RE =
  /\b(?:look up|search(?: for)?|fetch|weather|forecast|current|latest|find information|research)\b/i;

/** Coarse deterministic request class for routing. No model call and no repository scan. */
export function classifyTask(input: string): TaskClass {
  if (isExplicitBuild(input) || (isCodingTask(input) && BROAD_CODE_RE.test(input))) {
    return "broad_code";
  }
  const coding = isCodingTask(input);
  if (coding) {
    const normalized = stripLeadingPrefix(input.trim().toLowerCase());
    return ARTIFACT_OUTPUT_RE.test(normalized) ? "artifact" : "focused_code";
  }
  if (ARTIFACT_RE.test(input)) return "artifact";
  if (RETRIEVAL_RE.test(input)) return "retrieval";
  return "conversation";
}

/** Whether the user is reporting that already-built software is broken at runtime — a blank page,
 * a crash, a wrong result, "doesn't work". On such a turn the model needs to inspect the running
 * app to diagnose (curl/probe the live server, read logs), so the completion-audit probe guards —
 * which exist to stop a success-claiming turn from faking render evidence — must not block it. */
export function reportsRuntimeDefect(input: string): boolean {
  return /\b(?:blank (?:page|screen)|not working|does ?n['’]?t work|does not work|is ?n['’]?t working|is not working|broken|crash(?:e[sd]|ing)?|throws?|exception|stack ?trace|nothing (?:happens|shows|renders|loads)|do(?:es)? nothing|does ?n['’]?t (?:render|load|display|show|appear|update|respond)|white screen|502|500|404|undefined is not|cannot read (?:propert|properties)|still (?:broken|blank|not working|get)|this is (?:wrong|incorrect)|does the wrong)\b/i.test(
    input,
  );
}

/** Whether satisfying the request requires evidence from an actual rendered presentation rather
 * than merely a healthy process or HTTP response. */
export function requiresRenderEvidence(input: string): boolean {
  return /\b(?:html|tailwind|web ?page|website|frontend|user interface|ui|tui|gui|dashboard|component|screen|view|modal|dialog|form)\b/i.test(
    input,
  );
}

/** A runtime-defect report that is plausibly reproducible in the browser: a visual symptom (blank
 * page, nothing renders) or a misbehaving interaction (a button/tab/link/form). On such a turn,
 * reproducing the symptom with an interactive render_check before editing is the discipline that let
 * a capable model localize and fix the bug where a weak one spun (render2). Kept narrower than
 * reportsRuntimeDefect so a backend-only crash (a 500, a thrown parser error) gets no render nudge. */
export function reportsInteractiveRenderDefect(input: string): boolean {
  if (!reportsRuntimeDefect(input)) return false;
  return (
    requiresRenderEvidence(input) ||
    /\b(?:blank (?:page|screen)|white screen|nothing (?:renders?|shows?|displays?|appears?)|button|click(?:s|ed|ing)?|tab|link|menu|dropdown|navbar|sidebar|route|page|render(?:s|ed|ing)?)\b/i.test(
      input,
    )
  );
}
