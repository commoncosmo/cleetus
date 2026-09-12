import { describe, expect, it, test } from "bun:test";
import { BUILTIN_SKILLS } from "../../src/skills/builtins";

describe("BUILTIN_SKILLS", () => {
  it("includes a security-scan skill marked built-in", () => {
    const scan = BUILTIN_SKILLS.find((s) => s.name === "security-scan");
    expect(scan).toBeDefined();
    expect(scan!.source).toBe("built-in");
    expect(scan!.description.length).toBeGreaterThan(0);
  });

  it("the security-scan body covers scope, tools, manual review, and the report", () => {
    const body = BUILTIN_SKILLS.find((s) => s.name === "security-scan")!.body.toLowerCase();
    expect(body).toContain("diff");
    expect(body).toContain("whole codebase");
    expect(body).toContain("semgrep");
    expect(body).toContain("opengrep");
    expect(body).toContain("manual review");
    expect(body).toContain(".cleetus/scans/");
  });

  it("includes a test-driven-development skill marked built-in", () => {
    const tdd = BUILTIN_SKILLS.find((s) => s.name === "test-driven-development");
    expect(tdd).toBeDefined();
    expect(tdd!.source).toBe("built-in");
    expect(tdd!.description.length).toBeGreaterThan(0);
  });

  it("the tdd body covers the red-green loop, the testability heuristic, and scaffold recipes", () => {
    const body = BUILTIN_SKILLS.find(
      (s) => s.name === "test-driven-development",
    )!.body.toLowerCase();
    expect(body).toContain("failing test");
    expect(body).toContain("run_tests");
    expect(body).toContain("filter");
    expect(body).toContain("bun test");
    expect(body).toContain("vitest");
    expect(body).toContain("pytest");
    expect(body).toContain("not unit-testable");
    // A UI component's behavior IS unit-testable — guard against the "just UI, skip it" reflex,
    // and keep the concrete happy-dom + Testing-Library recipe available.
    expect(body).toContain("component is unit-testable");
    expect(body).toContain("happy-dom");
    expect(body).toContain("@testing-library/react");
  });

  it("has exactly the four built-ins, each built-in, with the exact descriptions", () => {
    expect(BUILTIN_SKILLS).toHaveLength(4);
    expect(BUILTIN_SKILLS.map((s) => s.name).sort()).toEqual([
      "security-scan",
      "spec-creator",
      "test-driven-development",
      "workflow-creator",
    ]);
    for (const s of BUILTIN_SKILLS) expect(s.source).toBe("built-in");

    const scan = BUILTIN_SKILLS.find((s) => s.name === "security-scan")!;
    expect(scan.description).toBe(
      "Scan the codebase (or current diff) for security issues; uses semgrep/opengrep if present, plus a manual review, and writes a report",
    );
    const tdd = BUILTIN_SKILLS.find((s) => s.name === "test-driven-development")!;
    expect(tdd.description).toBe(
      "Drive a change test-first: write a failing test, run it focused with run_tests, then the minimal code to pass it; scaffold a runner if the stack makes it cheap",
    );
    const specCreator = BUILTIN_SKILLS.find((s) => s.name === "spec-creator")!;
    expect(specCreator.description).toBe(
      "Turn a rough idea into an accepted requirements/design spec before the host offers implementation choices",
    );
    const workflowCreator = BUILTIN_SKILLS.find((s) => s.name === "workflow-creator")!;
    expect(workflowCreator.description).toBe(
      "Design a strict workflow through a short bounded interview when the user explicitly asks to create a workflow",
    );
  });

  it("strips the frontmatter from each body (parsed, not raw markdown)", () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.body.length).toBeGreaterThan(0);
      expect(s.body.startsWith("---")).toBe(false);
      expect(s.body).not.toContain("\nname:");
    }
  });
});

describe("built-in skill triggers", () => {
  it("test-driven-development auto-triggers on coding tasks", () => {
    const tdd = BUILTIN_SKILLS.find((s) => s.name === "test-driven-development");
    expect(tdd?.trigger).toEqual({ when: ["coding-task"], match: [] });
  });
  it("security-scan has no trigger (manual only)", () => {
    const sec = BUILTIN_SKILLS.find((s) => s.name === "security-scan");
    expect(sec?.trigger).toBeUndefined();
  });
});

test("spec-creator is a manual-only built-in", () => {
  const skill = BUILTIN_SKILLS.find((s) => s.name === "spec-creator");
  expect(skill).toBeDefined();
  expect(skill!.source).toBe("built-in");
  expect(skill!.trigger).toBeUndefined(); // command-only in v1 — no auto-invocation
  expect(skill!.body.length).toBeGreaterThan(0);
});
