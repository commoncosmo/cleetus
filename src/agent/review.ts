/** Role preamble for the adversarial `review` subagent. Layered onto the parent system prompt by
 *  `subagentSystemPrompt`, so the reviewer keeps the environment/repo-map grounding and adds an
 *  attack-and-verify posture. Behaviour lives here (the reviewer's domain module), not in the
 *  generic subagent wiring. */
export const REVIEWER_PREAMBLE = [
  "You are an ADVERSARIAL code reviewer working in an isolated context. You are given a set of",
  "changes (a diff) and, when available, the ORIGINAL REQUEST that motivated them. Your job is to",
  "find what is WRONG — do not summarize or restate what the code does; that is a failure.",
  "",
  "Hunt for: correctness bugs and broken edge cases; security and privacy problems; unsupported",
  "claims; and SCOPE issues — anything built that the original request did not ask for (scope creep)",
  "or anything the request asked for that is missing.",
  "",
  "VERIFY BY EXECUTION, SCOPED. You can run `run_tests` and read-only `bash` probes to confirm a",
  "defect. Run something ONLY to confirm a SPECIFIC suspected defect — never a blanket re-run of the",
  "whole suite, and never re-run what was just run before you were invoked. You cannot edit files.",
  "",
  "Report findings as a markdown list, ONE bullet per finding, in this exact shape and nothing after:",
  "",
  "[Critical] path/to/file.ts:42 — one-line description of the defect.",
  "  verified: ran `bun test foo.test.ts`; the empty-input case throws.",
  "[Minor] path/to/other.ts:12 — scope creep: added a --json flag the request did not ask for.",
  "  verified: no (static).",
  "",
  "Severity is one of [Critical], [Important], [Minor]. Each finding MUST include a `verified:` line",
  "that either names the command you ran to confirm it, or says `no (static)` for a reasoned-but-",
  "unexecuted finding. If you find nothing, reply exactly: No issues found.",
].join("\n");

export interface ReviewSubject {
  /** "diff" reviews a unified diff; "codebase" surveys the whole tree. Absent ⇒ treated as "diff". */
  kind?: "diff" | "codebase";
  /** The unified diff under review (empty for a codebase subject). */
  diff: string;
  /** Files touched by the diff (best-effort; empty for a codebase subject). */
  files: string[];
  /** Human label for the subject, e.g. "working-tree diff" or "the entire codebase". */
  label: string;
}

export interface Finding {
  /** Positional id — "R1", "R2", … assigned by parseFindings. */
  id: string;
  severity: "Critical" | "Important" | "Minor";
  /** "src/foo.ts:42" (best-effort; "" if the model omitted it). */
  location: string;
  /** One or more lines, joined with spaces. */
  description: string;
  /** Raw text after "verified:" ("" if the finding had no verified line). */
  verified: string;
  /** true = executed/confirmed (✓); false = static/unverified (○). */
  ran: boolean;
}

const SEVERITY_RE = /^\s*\[(critical|important|minor)\]\s*(.*)$/i;
const VERIFIED_RE = /^\s*verified:\s*(.*)$/i;

/** Split "src/foo.ts:42 — desc" into location + description. The separator is an em/en dash or a
 *  SPACE-surrounded hyphen, so a line range like `32-41` (no trailing space) is not split. */
function splitLocation(rest: string): { location: string; description: string } {
  const m = /^(.*?)\s*[—–-]\s+(.*)$/.exec(rest);
  if (m) return { location: m[1]!.trim(), description: m[2]!.trim() };
  if (/^\S+:\d/.test(rest)) return { location: rest.trim(), description: "" };
  return { location: "", description: rest.trim() };
}

/** Parse the reviewer's structured-lite text into findings, tagging each with a positional id.
 *  Lenient by design (the reviewer is a small model): a finding starts at a `[Severity]` line;
 *  non-severity, non-`verified:` lines fold into the description. Returns [] when nothing parses
 *  (the caller falls back to the raw text). */
export function parseFindings(raw: string): Finding[] {
  const findings: Finding[] = [];
  let cur: Finding | null = null;
  const flush = () => {
    if (cur) {
      cur.description = cur.description.trim();
      findings.push(cur);
      cur = null;
    }
  };
  // Normalize CRLF/CR first: a trailing \r fails the `(.*)$` severity/verified regexes, which
  // would silently drop a \r\n-emitting reviewer's entire output to the raw fallback.
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const sev = SEVERITY_RE.exec(line);
    if (sev) {
      flush();
      const tag = sev[1]!.toLowerCase();
      const severity = (tag[0]!.toUpperCase() + tag.slice(1)) as Finding["severity"];
      const { location, description } = splitLocation(sev[2]!.trim());
      cur = {
        id: `R${findings.length + 1}`,
        severity,
        location,
        description,
        verified: "",
        ran: false,
      };
      continue;
    }
    const ver = VERIFIED_RE.exec(line);
    if (ver && cur) {
      cur.verified = ver[1]!.trim();
      cur.ran = !/^(no|static)\b/i.test(cur.verified);
      continue;
    }
    if (cur && line.trim()) {
      cur.description += (cur.description ? " " : "") + line.trim();
    }
  }
  flush();
  return findings;
}

const SEVERITY_EMOJI: Record<Finding["severity"], string> = {
  Critical: "🔴",
  Important: "🟡",
  Minor: "⚪",
};

/** Turn the reviewer's raw text into the plan-style markdown injected into the conversation.
 *  Single entry point: owns the clean-diff case, the parse, and the format-drift fallback. */
export function formatFindings(raw: string): string {
  const text = raw.trim();
  if (!text || /^no issues found\.?$/i.test(text)) {
    return "## Review — no issues found.";
  }
  const findings = parseFindings(raw);
  if (findings.length === 0) {
    return `## Review\n\n${text}`;
  }
  const lines: string[] = [
    `## Review — ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
  ];
  for (const f of findings) {
    lines.push("");
    const head = [`**${f.id}**`, `${SEVERITY_EMOJI[f.severity]} ${f.severity}`];
    if (f.location) head.push(`\`${f.location}\``);
    lines.push(head.join(" · "));
    if (f.description) lines.push(f.description);
    lines.push(
      f.ran ? `✓ ${f.verified || "verified"}` : `○ ${f.verified || "static (not executed)"}`,
    );
  }
  lines.push("");
  lines.push('_Reference a finding to act — e.g. "fix R2", "plan R1 and R3"._');
  return lines.join("\n");
}

/** Compose the reviewer's task prompt from the subject and (optional) originating intent. */
export function buildReviewerPrompt(input: { subject: ReviewSubject; intent?: string }): string {
  const { subject, intent } = input;
  const parts: string[] =
    subject.kind === "codebase"
      ? [
          "Review the ENTIRE codebase for defects. You are not given a diff — survey the code yourself.",
          "Start with `list_dir` and the repo map (if available) to learn the structure, then use",
          "`read_file` and `grep` to inspect the highest-risk areas: entry points, input parsing, auth,",
          "file/network I/O, concurrency, and error handling. You cannot read every line — prioritize.",
          "Attack correctness, security/privacy, and code-quality issues.",
        ]
      : [
          `Review the following ${subject.label}.`,
          subject.files.length ? `Files touched: ${subject.files.join(", ")}` : "",
          "",
          "```diff",
          subject.diff,
          "```",
        ];
  if (intent?.trim()) {
    parts.push(
      "",
      "ORIGINAL REQUEST (judge scope-adherence against this — flag anything extra or missing):",
      intent.trim(),
    );
  }
  return parts.filter((p) => p !== "").join("\n");
}

/** Narrow git runner the subject resolver needs — an adapter over `runGit(sandbox, argv, ctx)`.
 *  Kept structural so `resolveSubject` is unit-testable without a sandbox. */
export type GitRunner = (argv: string[]) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

function parseFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.+?) b\//.exec(line);
    if (m?.[1]) files.push(m[1]);
  }
  return files;
}

/** Resolve the review subject from `/review` args. No args → working-tree diff vs HEAD; a single
 *  arg that git can resolve as a commit → diff vs that ref; otherwise the args are treated as paths.
 *  Returns null when the resulting diff is empty (caller short-circuits with "nothing to review"). */
export async function resolveSubject(
  git: GitRunner,
  args: string[],
): Promise<ReviewSubject | null> {
  // `/review all` → whole-codebase review, with or without a repo. Return before touching git.
  if (args.length === 1 && args[0]!.toLowerCase() === "all") {
    return { kind: "codebase", diff: "", files: [], label: "the entire codebase" };
  }
  // Repo gate BEFORE any `git diff`: a non-repo `git diff` exits 0 while emitting `--no-index`
  // usage, which the exit-code guard below can't catch. rev-parse tells us cleanly; non-repo → null
  // (the caller suggests `/review all`).
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") return null;

  let argv: string[];
  let label: string;
  if (args.length === 0) {
    argv = ["diff", "HEAD"];
    label = "working-tree diff";
  } else if (args.length === 1) {
    const ref = args[0]!;
    const probe = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (probe.exitCode === 0) {
      argv = ["diff", ref];
      label = `diff vs ${ref}`;
    } else {
      argv = ["diff", "--", ref];
      label = `diff of ${ref}`;
    }
  } else {
    argv = ["diff", "--", ...args];
    label = `diff of ${args.join(", ")}`;
  }
  const res = await git(argv);
  // Surface a real git failure (not a git repo, no HEAD, bad ref/path) rather than silently
  // folding its empty stdout into the "nothing to review" (null) path — the caller's try/catch
  // turns a throw into a "review failed: …" message. An empty stdout with exit 0 is a genuine
  // no-changes diff and still returns null.
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || `git ${argv.join(" ")} failed (exit ${res.exitCode})`);
  }
  const diff = res.stdout;
  if (!diff.trim()) return null;
  return { kind: "diff", diff, files: parseFiles(diff), label };
}

/** The most recent user message in a conversation (the originating intent for `/review`). */
export function lastUserRequest(messages: { role: string; content: string }[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return undefined;
}

export interface RunReviewDeps {
  git: GitRunner;
  /** Spawn the reviewer sub-agent with the composed prompt; returns its findings text. */
  spawn: (prompt: string, signal: AbortSignal) => Promise<string>;
  /** Emit the formatted findings into the conversation (model-visible), instead of printing them.
   *  Wired to AgentRuntime.seedReviewFindings. */
  emitFindings: (markdown: string) => void;
  /** Originating request, if known — enables scope-adherence findings. */
  intent?: string;
  signal: AbortSignal;
}

/** On-demand review orchestrator shared by `/review`. Resolves the subject, short-circuits an empty
 *  diff, composes the reviewer prompt, spawns the reviewer, and emits its findings into the
 *  conversation (printing only status/error lines). */
export async function runReview(
  args: string[],
  deps: RunReviewDeps,
  print: (s: string) => void,
): Promise<void> {
  let subject: ReviewSubject | null;
  try {
    subject = await resolveSubject(deps.git, args);
  } catch (e) {
    print(`review failed: ${(e as Error).message}`);
    return;
  }
  if (!subject) {
    print(
      "No changes to review — not a git repository, or no diff against HEAD. " +
        "Run `/review all` to review the entire codebase.",
    );
    return;
  }
  const prompt = buildReviewerPrompt({ subject, intent: deps.intent });
  try {
    const findings = await deps.spawn(prompt, deps.signal);
    deps.emitFindings(formatFindings(findings));
  } catch (e) {
    print(`review failed: ${(e as Error).message}`);
  }
}
