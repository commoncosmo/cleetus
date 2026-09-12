import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { isImplementationPath } from "./change-kind";
import type { TaskClass } from "./coding-task";
import type { VerificationResult } from "./types";

export interface EditedFileSnapshot {
  path: string;
  before: string;
  after: string;
  created?: boolean;
}

export interface TestCoverageRegression {
  path: string;
  testsBefore: number;
  testsAfter: number;
  assertionsBefore: number;
  assertionsAfter: number;
}

export interface TestEvidenceWeakness {
  path: string;
  reason: string;
}

const AUDIT_PATH_TOOLS = new Set(["read_file", "grep", "glob"]);

/** Normalize the filesystem scope named by an inspection call. Completion audits may revisit
 * paths changed or inspected during the active turn, but must not reopen arbitrary older work. */
export function completionAuditInspectionPath(
  tool: string,
  args: unknown,
  projectDir: string,
): string | null {
  if (!AUDIT_PATH_TOOLS.has(tool)) return null;
  const record = (args ?? {}) as Record<string, unknown>;
  const raw = tool === "glob" ? record.cwd : record.path;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const root = resolve(projectDir);
  const target = isAbsolute(raw) ? normalize(raw) : resolve(root, raw);
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return normalize(rel);
}

export function completionAuditScopeBlock(
  tool: string,
  args: unknown,
  projectDir: string,
  allowedPaths: ReadonlySet<string>,
): string | null {
  if (!AUDIT_PATH_TOOLS.has(tool)) return null;
  const path = completionAuditInspectionPath(tool, args, projectDir);
  if (path && allowedPaths.has(path)) return null;
  return "The completion audit is limited to files changed or already inspected during this turn. Do not reopen unrelated files or specifications from earlier work; finalize from current evidence, or qualify the remaining claim.";
}

/** Data/document artifacts are not implementation builds and should keep their bounded handoff. */
export function hasImplementationChanges(snapshots: Iterable<EditedFileSnapshot>): boolean {
  for (const snapshot of snapshots) {
    if (isImplementationPath(snapshot.path)) return true;
  }
  return false;
}

export function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path);
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

/**
 * A deliberately conservative signal that an existing test file was replaced with weaker
 * coverage. It never blocks completion by itself: the completion audit asks the model either to
 * restore the lost cases or explicitly justify an intentional removal.
 */
export function testCoverageRegressions(
  snapshots: Iterable<EditedFileSnapshot>,
): TestCoverageRegression[] {
  const regressions: TestCoverageRegression[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.created || !isTestPath(snapshot.path) || !snapshot.before.trim()) continue;
    const testsBefore = count(snapshot.before, /\b(?:it|test)\s*(?:\.\w+)?\s*\(/g);
    const testsAfter = count(snapshot.after, /\b(?:it|test)\s*(?:\.\w+)?\s*\(/g);
    const assertionsBefore = count(snapshot.before, /\bexpect\s*\(/g);
    const assertionsAfter = count(snapshot.after, /\bexpect\s*\(/g);
    if (testsAfter < testsBefore || assertionsAfter < assertionsBefore) {
      regressions.push({
        path: snapshot.path,
        testsBefore,
        testsAfter,
        assertionsBefore,
        assertionsAfter,
      });
    }
  }
  return regressions.sort((a, b) => a.path.localeCompare(b.path));
}

/** Detect newly-added tests whose assertions prove only that symbols/modules exist. These tests
 * can be useful smoke checks, but they are not behavioral evidence and must not satisfy a feature
 * requirement by themselves. Conservative: flag only when every assertion is a known shape-only
 * form, avoiding judgment about mixed or substantive suites. */
export function testEvidenceWeaknesses(
  snapshots: Iterable<EditedFileSnapshot>,
): TestEvidenceWeakness[] {
  const weaknesses: TestEvidenceWeakness[] = [];
  for (const snapshot of snapshots) {
    if (!isTestPath(snapshot.path)) continue;
    // A reload assertion before remount cannot prove restoration. Advisory only; helper-based
    // assertions may justify this finding during the bounded audit.
    const cases = snapshot.after.split(/\b(?:it|test)\s*\(\s*["'`]/).slice(1);
    for (const body of cases) {
      if (!/^[^"'`]*(?:reload|restor|persist)/i.test(body) || !/\bunmount\s*\(/.test(body))
        continue;
      const renders = [...body.matchAll(/\brender\s*\([^;\n]*\)/g)];
      const last = renders[renders.length - 1];
      if (last && !/\b(?:expect|assert)\s*[.(]/.test(body.slice(last.index! + last[0].length))) {
        weaknesses.push({
          path: snapshot.path,
          reason: "reload/restoration test remounts without asserting restored behavior afterward",
        });
      }
    }
    if (!snapshot.created) continue;
    const assertions = count(snapshot.after, /\bexpect\s*\(/g);
    if (assertions === 0) continue;
    const typeofFunction = count(
      snapshot.after,
      /expect\s*\(\s*typeof\s+[^)]*\)\s*\.\s*toBe\s*\(\s*["']function["']\s*\)/g,
    );
    const defined = count(
      snapshot.after,
      /expect\s*\([^)]*\)\s*\.\s*(?:toBeDefined|toHaveProperty)\s*\(/g,
    );
    if (typeofFunction + defined >= assertions) {
      weaknesses.push({
        path: snapshot.path,
        reason:
          "new tests assert only module/symbol shape; they do not exercise the promised behavior",
      });
    }
  }
  return weaknesses.sort((a, b) => a.path.localeCompare(b.path));
}

function hasPassing(
  results: VerificationResult[],
  pattern: RegExp,
  predicate: (result: VerificationResult) => boolean = () => true,
): boolean {
  return results.some((result) => result.ok && pattern.test(result.key) && predicate(result));
}

function isTestVerification(result: VerificationResult): boolean {
  if (result.evidence) return result.evidence === "test" || result.evidence === "render";
  return /(?:run_tests|\btest\b|vitest|jest|playwright|mocha|ava|pytest)/i.test(result.key);
}

function isRuntimeSmoke(result: VerificationResult): boolean {
  if (!result.ok || !/^smoke_run:/i.test(result.key)) return false;
  if (/\s(?:--help|-h|--version)(?:\s|$)/i.test(result.command)) return false;
  if (!/^(?:✓|⏱)/m.test(result.detail) || /^[✗⚠]/m.test(result.detail)) return false;
  return !/no models? available|no provider|did not reach|without reaching/i.test(result.detail);
}

function isRenderEvidence(result: VerificationResult): boolean {
  if (!result.ok) return false;
  if (result.evidence === "render") return true;
  return /\b(?:playwright\s+test|cypress\s+run)\b/i.test(`${result.key} ${result.command}`);
}

/** A broad implementation still benefits from semantic review. Focused work should not be sent
 * back through an open-ended reviewer after both its behavior and runtime path are already current
 * and green; doing so made the route2 audit invent a defect and invalidate good evidence. */
export function shouldRunCompletionAudit(args: {
  taskClass: TaskClass;
  verificationResults: VerificationResult[];
  regressions: TestCoverageRegression[];
  weakTests: TestEvidenceWeakness[];
  unsupportedClaims: string[];
  requiresRenderEvidence?: boolean;
}): boolean {
  if (args.taskClass === "broad_code") return true;
  if (
    args.regressions.length > 0 ||
    args.weakTests.length > 0 ||
    args.unsupportedClaims.length > 0
  ) {
    return true;
  }
  if (args.taskClass !== "focused_code") return false;
  const current = args.verificationResults.filter((result) => !result.baseline);
  const passingTest = current.some((result) => result.ok && isTestVerification(result));
  if (args.requiresRenderEvidence) {
    return !(passingTest && current.some(isRenderEvidence));
  }
  const passingSmoke = current.some(isRuntimeSmoke);
  return !(passingTest && passingSmoke);
}

function claimsSuccess(text: string, pattern: RegExp): boolean {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  return sentences.some((sentence) => {
    if (!pattern.test(sentence)) return false;
    return !/\b(?:not|never|unverified|could(?:n't| not)|did(?:n't| not)|was(?:n't| not)|without)\b/i.test(
      sentence,
    );
  });
}

/** Claims in a draft final response that are not supported by the runtime's tool evidence.
 * Render language is intentionally interpreted in the context of the originating request:
 * formatters, serializers, and tests routinely "render" strings without producing a visual
 * presentation that a browser could verify. */
export function unsupportedCompletionClaims(
  text: string,
  results: VerificationResult[],
  options: { requiresRenderEvidence?: boolean } = {},
): string[] {
  const warnings: string[] = [];
  const lower = text.toLowerCase();
  if (/\b(?:tests?|test suite|suite)\b.{0,40}\b(?:pass(?:ed|es)?|green|clean)\b/is.test(text)) {
    if (!hasPassing(results, /(?:run_tests|\btest\b|vitest|jest|playwright|mocha|ava|pytest)/i)) {
      warnings.push("the draft says tests pass, but no successful test command was recorded");
    }
  }
  if (/\blint\b.{0,30}\b(?:pass(?:ed|es)?|green|clean)\b/is.test(text)) {
    if (!hasPassing(results, /lint/i)) {
      warnings.push("the draft says lint passes, but no successful lint command was recorded");
    }
  }
  if (/\btypecheck\b.{0,30}\b(?:pass(?:ed|es)?|green|clean)\b/is.test(text)) {
    if (!hasPassing(results, /typecheck|\btsc\b/i)) {
      warnings.push(
        "the draft says typecheck passes, but no successful typecheck command was recorded",
      );
    }
  }
  if (
    options.requiresRenderEvidence &&
    claimsSuccess(text, /\b(?:render(?:s|ed)?|mount(?:s|ed)?|shows? the new)\b/i)
  ) {
    if (!results.some(isRenderEvidence)) {
      warnings.push(
        "the draft claims a rendered presentation worked, but no browser/render verification was recorded",
      );
    }
  }
  if (claimsSuccess(text, /\b(?:launch(?:es|ed)?|starts?|serves?)\b/i)) {
    const runtimeSmoke = results.some(isRuntimeSmoke);
    if (!runtimeSmoke) {
      warnings.push(
        "the draft claims a launch/render path worked, but recorded smoke evidence did not reach that runtime path",
      );
    }
  }
  if (lower.includes("pre-existing") || lower.includes("preexisting")) {
    const failed = results.some((result) => !result.ok && !result.baseline);
    const baseline = results.some((result) => result.baseline);
    if (failed && !baseline) {
      warnings.push(
        "the draft calls failures pre-existing without a recorded isolated-baseline verification",
      );
    }
  }
  return warnings;
}

export function completionAuditReminder(args: {
  regressions: TestCoverageRegression[];
  weakTests: TestEvidenceWeakness[];
  unsupportedClaims: string[];
  verificationResults: VerificationResult[];
  changedPaths?: string[];
  inspectionPaths?: string[];
}): string {
  const {
    regressions,
    weakTests,
    unsupportedClaims,
    verificationResults,
    changedPaths = [],
    inspectionPaths = [],
  } = args;
  const sections = [
    "Before finalizing this implementation, perform one bounded completion audit using three evidence-driven phases: (1) inspect the existing diff and recorded evidence once and make a short requirement-by-requirement checklist, (2) repair only a concrete unmet requirement found during that inspection, and (3) run the smallest invalidated verification once, then finalize. If inspection finds no concrete defect, do not edit files and proceed directly to the final summary.",
    "Decide each audit question once and do not re-derive a decision you have already reasoned through; if you notice yourself weighing the same choice a second time, commit and act. Two cases have fixed defaults, so do not deliberate over them: an exploratory edit you already made during inspection that is a genuine improvement and passes (for example a real test that asserts behavior) is kept — do not deliberate over reverting it; and a latent issue whose observable behavior is already correct is not a concrete unmet requirement — note it as a limitation in the summary and do not fix it during this audit.",
    "Use observable behavior and direct implementation inspection as evidence. Comments, filenames, imports, component presence, handler counts, grep counts, compilation, and tests that only assert exports, symbol types, presence, or static strings are source-shape proxies; they do not prove the promised behavior or design. A visual/UI/layout requirement cannot be marked passed without browser/render verification such as render_check (a bundled headless-browser probe that launches the app and inspects the rendered page) or an existing Playwright/Cypress suite. A server-start smoke proves launch only; fetching HTML proves transport only. Neither proves that the page loaded its modules and rendered the changed presentation. When a requirement calls for shared behavior or a headless controller, raw setters/refs, repeated state transitions, duplicated derived expressions, and duplicated completion/dispatch chains in consumers still count as behavior duplication even if named handlers exist only once.",
    "Behavioral acceptance must exercise the promised transition: after reload/remount assert the restored model AND assistant conversation, while a controlled stream is pending assert busy state, and after content begins assert the requested thinking visibility. API mocks must match documented or observed response fields and framing; do not invent a field and then validate the implementation against that same invention. A test title is not evidence that its body checks the named behavior.",
    "Run known independent reads, searches, and checks together in one tool-call batch. Keep sequential calls only where one result determines the next target. This audit is not a fresh repository exploration. Do not create temporary servers, extra smoke-test files, or new test infrastructure solely to manufacture audit evidence. If the existing tools cannot prove a claim, qualify the claim instead of building a new harness.",
    "Verification commands must preserve the verifier's exit status: run the verifier alone, or use `status=$?; ...; exit $status` when cleanup/output shaping is required. `echo EXIT=$?` followed by another command is not sufficient. Use `smoke_run` for launch claims and `render_check` for browser/render claims so Cleetus can record the evidence; do not start a server or probe localhost through `bash`. Do not treat --help, argument acceptance, imports, compilation, or a no-provider exit as runtime proof.",
    "Never use git stash, git reset, or git checkout to establish a baseline or clean the worktree. Use a non-mutating isolated copy/archive when available; otherwise leave the failure unclassified and report that limitation. Prefix the verifier inside that isolated copy with `CLEETUS_VERIFICATION_BASELINE=1` so Cleetus records it as baseline evidence. Do not call a failure pre-existing without that recorded isolated-baseline run. Report only evidence actually produced by tools.",
  ];
  if (changedPaths.length > 0) {
    sections.push(
      `Files changed during this turn:\n${[...new Set(changedPaths)]
        .sort()
        .map((path) => `- ${path}`)
        .join(
          "\n",
        )}\nThis is change-scope evidence only. Do not claim these are the only files that exist in the project. If the user limited the requested change to specific files, assess that requirement from this changed-path list.`,
    );
  }
  const auditScope = [...new Set([...changedPaths, ...inspectionPaths])].sort();
  if (auditScope.length > 0) {
    sections.push(
      `Completion-audit inspection scope:\n${auditScope.map((path) => `- ${path}`).join("\n")}\nDo not inspect paths outside this list. It contains the files changed or already inspected during the active user turn; older conversation context is not part of this audit.`,
    );
  }
  if (verificationResults.length === 0) {
    sections.push("No test, lint, typecheck, or build verification has been recorded yet.");
  } else {
    const passed = verificationResults.filter((result) => result.ok);
    if (passed.length > 0) {
      sections.push(
        `These successful verification results are current for the present edit state. Treat them as authoritative and do not rerun the same command unless a repair changes files afterward:\n${passed.map((result) => `- ${result.command}`).join("\n")}`,
      );
    }
    const failed = verificationResults.filter((result) => !result.ok);
    if (failed.length > 0) {
      sections.push(
        `Current unresolved verification failures:\n${failed.map((result) => `- ${result.command}: ${result.detail.slice(-500)}`).join("\n")}`,
      );
    }
  }
  if (regressions.length > 0) {
    sections.push(
      `Existing test coverage appears reduced. Restore it unless the requested behavior intentionally removes those cases; if removal is intentional, explain it explicitly:\n${regressions
        .map(
          (item) =>
            `- ${item.path}: tests ${item.testsBefore}->${item.testsAfter}, assertions ${item.assertionsBefore}->${item.assertionsAfter}`,
        )
        .join("\n")}`,
    );
  }
  if (weakTests.length > 0) {
    sections.push(
      `New tests provide only source-shape evidence. Add behavioral coverage before using them to satisfy a feature requirement:\n${weakTests
        .map((item) => `- ${item.path}: ${item.reason}`)
        .join("\n")}`,
    );
  }
  if (unsupportedClaims.length > 0) {
    sections.push(
      `Unsupported claims in the draft final response:\n${unsupportedClaims.map((x) => `- ${x}`).join("\n")}`,
    );
  }
  sections.push(
    "When the audit is complete, provide a concise final summary that clearly separates verified facts from limitations. Do not merely restate the draft.",
  );
  return `<system-reminder>${sections.join("\n\n")}</system-reminder>`;
}

/** Make unresolved audit qualifications part of the delivered answer instead of relying on the
 * model to repeat a preceding notice accurately. This is deliberately append-only: it preserves
 * the model's useful summary while ensuring unsupported success claims cannot hide limitations. */
export function appendCompletionEvidenceQualification(text: string, details: string[]): string {
  if (details.length === 0) return text;
  const qualification = [
    "Verification limitations recorded by Cleetus:",
    ...details.map((detail) => `- ${detail}`),
  ].join("\n");
  return text.trimEnd() ? `${text.trimEnd()}\n\n${qualification}` : qualification;
}
