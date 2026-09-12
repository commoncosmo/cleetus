import { describe, expect, it } from "bun:test";
import {
  appendCompletionEvidenceQualification,
  completionAuditInspectionPath,
  completionAuditReminder,
  completionAuditScopeBlock,
  hasImplementationChanges,
  shouldRunCompletionAudit,
  testCoverageRegressions,
  testEvidenceWeaknesses,
  unsupportedCompletionClaims,
} from "../../src/agent/completion-audit";
import type { VerificationResult } from "../../src/agent/types";

describe("completion audit", () => {
  const passingTest: VerificationResult = {
    key: "bash:bun test",
    command: "bun test",
    ok: true,
    detail: "3 pass",
    scope: "full",
  };
  const passingSmoke: VerificationResult = {
    key: "smoke_run:bun run dev",
    command: "bun run dev",
    ok: true,
    detail: "⏱ bun run dev still running after 5s\nready",
    scope: "focused",
    evidence: "launch",
  };
  const passingRender: VerificationResult = {
    key: "bash:bunx playwright test",
    command: "bunx playwright test",
    ok: true,
    detail: "1 passed",
    scope: "focused",
    evidence: "render",
  };

  it("limits audit inspection to paths changed or inspected in the active turn", () => {
    const root = "/project";
    const allowed = new Set(["src/current.ts", "docs/current-spec.md"]);

    expect(
      completionAuditScopeBlock("read_file", { path: "src/current.ts" }, root, allowed),
    ).toBeNull();
    expect(
      completionAuditScopeBlock("grep", { path: "docs/current-spec.md" }, root, allowed),
    ).toBeNull();
    expect(
      completionAuditScopeBlock("read_file", { path: "src/old-task.ts" }, root, allowed),
    ).toContain("limited to files changed or already inspected");
    expect(completionAuditScopeBlock("glob", { pattern: "**/*" }, root, allowed)).toContain(
      "limited to files changed or already inspected",
    );
  });

  it("normalizes relative audit paths and rejects outside paths", () => {
    expect(
      completionAuditInspectionPath("read_file", { path: "./src/current.ts" }, "/project"),
    ).toBe("src/current.ts");
    expect(
      completionAuditInspectionPath("read_file", { path: "../outside.ts" }, "/project"),
    ).toBeNull();
  });

  it("skips speculative review for focused work with current test and smoke evidence", () => {
    expect(
      shouldRunCompletionAudit({
        taskClass: "focused_code",
        verificationResults: [passingTest, passingSmoke],
        regressions: [],
        weakTests: [],
        unsupportedClaims: [],
      }),
    ).toBe(false);
  });

  it("retains review for broad work and deterministic focused risks", () => {
    expect(
      shouldRunCompletionAudit({
        taskClass: "broad_code",
        verificationResults: [passingTest, passingSmoke],
        regressions: [],
        weakTests: [],
        unsupportedClaims: [],
      }),
    ).toBe(true);
    expect(
      shouldRunCompletionAudit({
        taskClass: "focused_code",
        verificationResults: [passingTest, passingSmoke],
        regressions: [],
        weakTests: [],
        unsupportedClaims: ["unsupported claim"],
      }),
    ).toBe(true);
  });

  it("does not confuse a server launch with rendered UI evidence", () => {
    expect(
      shouldRunCompletionAudit({
        taskClass: "focused_code",
        verificationResults: [passingTest, passingSmoke],
        regressions: [],
        weakTests: [],
        unsupportedClaims: [],
        requiresRenderEvidence: true,
      }),
    ).toBe(true);
    expect(
      shouldRunCompletionAudit({
        taskClass: "focused_code",
        verificationResults: [passingTest, passingRender],
        regressions: [],
        weakTests: [],
        unsupportedClaims: [],
        requiresRenderEvidence: true,
      }),
    ).toBe(false);
  });

  it("distinguishes implementation edits from documentation/spec drafting", () => {
    expect(
      hasImplementationChanges([
        { path: "docs/specs/feature.md", before: "", after: "# Feature", created: true },
      ]),
    ).toBe(false);
    expect(
      hasImplementationChanges([
        { path: "docs/specs/feature.md", before: "", after: "# Feature", created: true },
        { path: "src/feature.ts", before: "", after: "export {};", created: true },
      ]),
    ).toBe(true);
  });

  it("does not audit data exports but still audits manifests and web source", () => {
    expect(
      hasImplementationChanges([
        { path: "wilmette_forecast.json", before: "", after: "{}", created: true },
      ]),
    ).toBe(false);
    expect(
      hasImplementationChanges([{ path: "package.json", before: "{}", after: '{"scripts":{}}' }]),
    ).toBe(true);
    expect(
      hasImplementationChanges([
        { path: "public/index.html", before: "", after: "<main />", created: true },
      ]),
    ).toBe(true);
  });

  it("flags an existing test file whose cases and assertions were reduced", () => {
    expect(
      testCoverageRegressions([
        {
          path: "tests/ui/theme.test.ts",
          before: "test('a', () => expect(1).toBe(1));\ntest('b', () => expect(2).toBe(2));",
          after: "test('new', () => expect(1).toBe(1));",
        },
      ]),
    ).toEqual([
      {
        path: "tests/ui/theme.test.ts",
        testsBefore: 2,
        testsAfter: 1,
        assertionsBefore: 2,
        assertionsAfter: 1,
      },
    ]);
  });

  it("does not flag new tests or an existing test file with preserved coverage", () => {
    expect(
      testCoverageRegressions([
        {
          path: "tests/new.test.ts",
          before: "",
          after: "test('a', () => expect(1));",
          created: true,
        },
        {
          path: "tests/kept.test.ts",
          before: "test('a', () => expect(1));",
          after: "test('better', () => { expect(1); expect(2); });",
        },
      ]),
    ).toEqual([]);
  });

  it("flags a new export-only test as source-shape evidence", () => {
    expect(
      testEvidenceWeaknesses([
        {
          path: "tests/ui/tui/shell.test.ts",
          before: "",
          created: true,
          after: `
            test("exports shells", async () => {
              const mod = await import("../../../src/ui/tui/shell");
              expect(typeof mod.DefaultShell).toBe("function");
              expect(typeof mod.AltShell).toBe("function");
            });`,
        },
      ]),
    ).toEqual([
      {
        path: "tests/ui/tui/shell.test.ts",
        reason:
          "new tests assert only module/symbol shape; they do not exercise the promised behavior",
      },
    ]);
  });

  it("does not flag a new test that invokes behavior", () => {
    expect(
      testEvidenceWeaknesses([
        {
          path: "tests/ui/tui/shell.test.ts",
          before: "",
          created: true,
          after:
            'test("renders alt", () => { const output = render(<AltShell />).lastFrame(); expect(output).toContain("┌"); });',
        },
      ]),
    ).toEqual([]);
  });

  it("rejects launch and pre-existing-failure claims without supporting evidence", () => {
    const failed: VerificationResult = {
      key: "bash:bun test",
      command: "bun test",
      ok: false,
      detail: "3 tests failed",
      scope: "full",
    };
    expect(
      unsupportedCompletionClaims(
        "The app launches correctly. The three failures are pre-existing.",
        [failed],
      ),
    ).toEqual([
      "the draft claims a launch/render path worked, but recorded smoke evidence did not reach that runtime path",
      "the draft calls failures pre-existing without a recorded isolated-baseline verification",
    ]);
  });

  it("does not treat --help or a no-provider exit as runtime smoke evidence", () => {
    const help: VerificationResult = {
      key: "smoke_run:cleetus --help",
      command: "cleetus --help",
      ok: true,
      detail: "Usage: cleetus",
    };
    const noProvider: VerificationResult = {
      key: "smoke_run:cleetus --tui alt",
      command: "cleetus --tui alt",
      ok: true,
      detail: "no models available from any configured provider",
    };
    expect(
      unsupportedCompletionClaims("The alternate UI launches and renders.", [help, noProvider]),
    ).toContain(
      "the draft claims a launch/render path worked, but recorded smoke evidence did not reach that runtime path",
    );
  });

  it("does not flag an explicitly qualified launch limitation as a success claim", () => {
    expect(unsupportedCompletionClaims("The runtime launch path was not verified.", [])).toEqual(
      [],
    );
  });

  it("accepts a healthy runtime smoke verdict as launch evidence", () => {
    const smoke: VerificationResult = {
      key: "smoke_run:bun run dev",
      command: "bun run dev",
      ok: true,
      detail: "⏱ bun run dev still running after 5s\nready on http://localhost:5173",
    };
    expect(
      unsupportedCompletionClaims("The development server launches correctly.", [smoke]),
    ).toEqual([]);
  });

  it("requires browser-level evidence for render claims", () => {
    expect(
      unsupportedCompletionClaims("The page renders correctly.", [passingSmoke], {
        requiresRenderEvidence: true,
      }),
    ).toContain(
      "the draft claims a rendered presentation worked, but no browser/render verification was recorded",
    );
    expect(
      unsupportedCompletionClaims("The page renders correctly.", [passingRender], {
        requiresRenderEvidence: true,
      }),
    ).toEqual([]);
  });

  it("does not interpret non-visual render wording as a browser claim", () => {
    expect(
      unsupportedCompletionClaims(
        "The formatter renders 'Unavailable' for a null interval description.",
        [],
        { requiresRenderEvidence: false },
      ),
    ).toEqual([]);
  });

  it("accepts a successful bunx vitest run as test evidence", () => {
    const vitest: VerificationResult = {
      key: "bash:bunx vitest run",
      command: "bash bunx vitest run",
      ok: true,
      detail: "7 tests passed",
      scope: "full",
    };
    expect(unsupportedCompletionClaims("All tests pass.", [vitest])).toEqual([]);
  });

  it("renders a bounded audit with verification and test-integrity evidence", () => {
    const text = completionAuditReminder({
      regressions: [
        {
          path: "tests/x.test.ts",
          testsBefore: 3,
          testsAfter: 1,
          assertionsBefore: 4,
          assertionsAfter: 1,
        },
      ],
      weakTests: [
        {
          path: "tests/ui/tui/shell.test.ts",
          reason: "new tests assert only module/symbol shape",
        },
      ],
      unsupportedClaims: ["unsupported launch claim"],
      verificationResults: [],
      changedPaths: ["tests/x.test.ts", "src/x.ts"],
    });
    expect(text).toContain("one bounded completion audit");
    expect(text).toContain("tests/x.test.ts: tests 3->1");
    expect(text).toContain("unsupported launch claim");
    expect(text).toContain("No test, lint, typecheck, or build verification");
    expect(text).toContain("requirement-by-requirement checklist");
    expect(text).toContain("source-shape proxies");
    expect(text).toContain("render_check");
    expect(text).toContain("tests/ui/tui/shell.test.ts");
    expect(text).toContain("raw setters/refs");
    expect(text).toContain("one tool-call batch");
    expect(text).toContain("status=$?");
    expect(text).toContain("Use `smoke_run`");
    expect(text).toContain("Never use git stash");
    expect(text).toContain("CLEETUS_VERIFICATION_BASELINE=1");
    expect(text).toContain("Files changed during this turn");
    expect(text).toContain("Do not claim these are the only files that exist");
  });

  it("gives decisive rules for the two forks that deadlocked qwen3.8 (ctest q38-1)", () => {
    // The audit's "repair only a concrete unmet requirement / do not edit if no defect" collided
    // with (a) an exploratory edit the model already made during inspection and (b) a latent bug
    // whose observable behavior was already correct. The model oscillated keep-vs-revert and
    // fix-vs-report until the stream watchdog stopped it — twice. The reminder must resolve both
    // forks with a default action instead of leaving the model to deliberate.
    const text = completionAuditReminder({
      regressions: [],
      weakTests: [],
      unsupportedClaims: [],
      verificationResults: [],
    });
    // Fork 1: already edited during inspection, but the edit is genuine → keep, don't agonize.
    expect(text).toContain("do not deliberate over reverting");
    // Fork 2: latent issue with correct observable behavior → report, don't fix.
    expect(text).toContain("not a concrete unmet requirement");
    // General: decide once, do not re-derive a decision already reasoned through.
    expect(text).toContain("do not re-derive");
  });

  it("tells the audit to reuse current passing verification", () => {
    const text = completionAuditReminder({
      regressions: [],
      weakTests: [],
      unsupportedClaims: [],
      verificationResults: [
        {
          key: "bash:bun test",
          command: "bun test",
          ok: true,
          detail: "12 pass",
        },
      ],
    });
    expect(text).toContain("Treat them as authoritative");
    expect(text).toContain("do not rerun the same command unless a repair changes files");
  });

  it("appends unresolved evidence qualifications to the delivered answer", () => {
    expect(
      appendCompletionEvidenceQualification("Implemented the feature.", [
        "runtime launch was not verified",
        "tests/example.test.ts reduced assertions 4->1",
      ]),
    ).toBe(
      "Implemented the feature.\n\nVerification limitations recorded by Cleetus:\n- runtime launch was not verified\n- tests/example.test.ts reduced assertions 4->1",
    );
    expect(appendCompletionEvidenceQualification("done", [])).toBe("done");
  });
});

it("identifies a reload test that asserts before remount but never checks restored state", () => {
  const weakness = testEvidenceWeaknesses([
    {
      path: "src/App.test.tsx",
      before: "",
      created: true,
      after: `it('restores the session on reload', () => { const { unmount } = render(<App />); expect(saved).toBeTruthy(); unmount(); render(<App />); });`,
    },
  ]);
  expect(weakness.some((item) => item.reason.includes("remounts without asserting"))).toBe(true);
});
