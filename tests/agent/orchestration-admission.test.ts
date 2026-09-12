import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admissionChoicePayload,
  analyzeOrchestrationAdmission,
  approvedPlanHasUnresolvedEvidence,
  hasFocusedAcceptance,
  namedTaskFiles,
  recommendedAdmissionChoice,
  renderAdmissionReport,
} from "../../src/agent/orchestration-admission";
import type { OrchestrationPlan, PlanTask } from "../../src/agent/orchestrator";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function task(
  id: string,
  title: string,
  description: string,
  acceptanceCriteria: string[],
  agentType: PlanTask["agentType"] = "general",
): PlanTask {
  return { id, title, description, acceptanceCriteria, agentType, status: "pending" };
}

function plan(tasks: PlanTask[], objective = "Migrate each provider adapter"): OrchestrationPlan {
  return { objective, brief: "brief", location: { kind: "cwd" }, tasks };
}

describe("admission evidence", () => {
  test("extracts named files and recognizes focused behavior checks", () => {
    const candidate = task(
      "t1",
      "Update adapter",
      "Edit `src/providers/a.ts` and tests/providers/a.test.ts.",
      ["bun test tests/providers/a.test.ts asserts the adapter round-trip"],
    );
    expect(namedTaskFiles(candidate)).toEqual(["src/providers/a.ts", "tests/providers/a.test.ts"]);
    expect(hasFocusedAcceptance(candidate)).toBe(true);
  });

  test("does not treat a broad integration gate as focused leaf acceptance", () => {
    const candidate = task("t1", "Update adapter", "Edit src/providers/a.ts", [
      "The full test suite passes",
    ]);
    expect(hasFocusedAcceptance(candidate)).toBe(false);
  });
});

test("hybrid uses the safe single-agent default until staged execution exists", () => {
  expect(recommendedAdmissionChoice("orchestrated")).toBe("workers");
  expect(recommendedAdmissionChoice("hybrid")).toBe("single");
  expect(recommendedAdmissionChoice("single")).toBe("single");
});

test("choice telemetry records when the user overrides the recommendation", () => {
  const report = {
    strategy: "single" as const,
    confidence: 0.8,
    score: -4,
    summary: "single",
    reasons: [],
    risks: [],
    facts: {
      implementationTasks: 1,
      exploreTasks: 0,
      tasksWithFocusedAcceptance: 1,
      tasksWithoutNamedFiles: 0,
      referencedFiles: ["src/app.ts"],
      sharedFiles: [],
      largeSharedFiles: [],
      subjectiveVisualWork: false,
      unresolvedArchitecture: false,
      stagedDiscovery: false,
      mechanicalWork: false,
    },
  };
  expect(admissionChoicePayload(report, "workers")).toMatchObject({
    strategy: "single",
    choice: "workers",
    recommended: "single",
    overridden: true,
  });
});

test("recommends orchestration for disjoint, focused mechanical leaves", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cleetus-admission-"));
  dirs.push(projectDir);
  const report = await analyzeOrchestrationAdmission({
    projectDir,
    plan: plan([
      task("t1", "Migrate adapter A", "Edit src/providers/a.ts", [
        "bun test tests/providers/a.test.ts asserts the adapter round-trip",
      ]),
      task("t2", "Migrate adapter B", "Edit src/providers/b.ts", [
        "bun test tests/providers/b.test.ts asserts the adapter round-trip",
      ]),
      task("t3", "Migrate adapter C", "Edit src/providers/c.ts", [
        "bun test tests/providers/c.test.ts asserts the adapter round-trip",
      ]),
      task("t4", "Migrate adapter D", "Edit src/providers/d.ts", [
        "bun test tests/providers/d.test.ts asserts the adapter round-trip",
      ]),
    ]),
  });

  expect(report.strategy).toBe("orchestrated");
  expect(report.facts.sharedFiles).toEqual([]);
  expect(renderAdmissionReport(report)).toContain("Execution recommendation: orchestrated");
});

test("does not mistake unknown-input handling for unresolved architecture", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cleetus-admission-"));
  dirs.push(projectDir);
  const report = await analyzeOrchestrationAdmission({
    projectDir,
    plan: plan(
      [
        task("t1", "Migrate adapter A", "Edit src/providers/a.ts", [
          "bun test tests/providers/a.test.ts asserts unknown events are ignored",
        ]),
        task("t2", "Migrate adapter B", "Edit src/providers/b.ts", [
          "bun test tests/providers/b.test.ts asserts malformed input is ignored",
        ]),
        task("t3", "Migrate adapter C", "Edit src/providers/c.ts", [
          "bun test tests/providers/c.test.ts asserts the adapter round-trip",
        ]),
        task("t4", "Migrate adapter D", "Edit src/providers/d.ts", [
          "bun test tests/providers/d.test.ts asserts the adapter round-trip",
        ]),
      ],
      "Safely ignore unknown events and malformed payload fields",
    ),
  });

  expect(report.facts.unresolvedArchitecture).toBe(false);
  expect(report.strategy).toBe("orchestrated");
});

test("recommends one agent when subjective UI tasks share a large root", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cleetus-admission-"));
  dirs.push(projectDir);
  const source = join(projectDir, "src", "ui");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "app.tsx"),
    Array.from({ length: 650 }, (_, i) => `// ${i}`).join("\n"),
  );
  const report = await analyzeOrchestrationAdmission({
    projectDir,
    plan: plan(
      [
        task("t1", "Redesign message log", "Edit src/ui/app.tsx for a polished message log", [
          "bun test tests/ui/message-log.test.tsx asserts the rendered interaction",
        ]),
        task("t2", "Redesign composer", "Edit src/ui/app.tsx for an intuitive composer", [
          "bun test tests/ui/composer.test.tsx asserts submit interaction",
        ]),
        task("t3", "Wire theme", "Edit src/ui/app.tsx for a modern visual theme", [
          "bun test tests/ui/theme.test.tsx asserts the rendered theme",
        ]),
      ],
      "Build a polished alternate TUI redesign",
    ),
  });

  expect(report.strategy).toBe("single");
  expect(report.facts.sharedFiles).toEqual(["src/ui/app.tsx"]);
  expect(report.facts.largeSharedFiles[0]).toContain("650 lines");
  expect(report.risks).toContain(
    "subjective visual quality benefits from one coherent implementation pass",
  );
});

test("recommends staged workers when one bounded exploration precedes disjoint leaves", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cleetus-admission-"));
  dirs.push(projectDir);
  const report = await analyzeOrchestrationAdmission({
    projectDir,
    plan: plan([
      task(
        "t1",
        "Determine controller seam",
        "Investigate the unclear shared state boundary",
        [],
        "explore",
      ),
      task("t2", "Extract controller", "Edit src/ui/controller.ts", [
        "bun test tests/ui/controller.test.ts asserts state transitions",
      ]),
      task("t3", "Build message log", "Edit src/ui/message-log.tsx", [
        "bun test tests/ui/message-log.test.tsx asserts rendered messages",
      ]),
      task("t4", "Build composer", "Edit src/ui/composer.tsx", [
        "bun test tests/ui/composer.test.tsx asserts submit interaction",
      ]),
    ]),
  });

  expect(report.strategy).toBe("orchestrated");
  expect(report.facts.exploreTasks).toBe(1);
  expect(report.facts.stagedDiscovery).toBe(true);
  expect(renderAdmissionReport(report)).toContain("Execution recommendation: orchestrated");
});

test("resolved open-question prose does not create an unresolved-architecture risk", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cleetus-admission-"));
  dirs.push(projectDir);
  const candidate = plan([
    task("t1", "Build A", "Edit src/a.ts", ["counts malformed records safely"]),
    task("t2", "Build B", "Edit src/b.ts", ["groups records by kind"]),
    task("t3", "Build C", "Edit src/c.ts", ["formats the aggregate result"]),
  ]);
  candidate.approvedPlan = "Architectural decisions resolved (from spec open questions).";

  const report = await analyzeOrchestrationAdmission({ projectDir, plan: candidate });

  expect(report.facts.unresolvedArchitecture).toBe(false);
  expect(report.strategy).toBe("orchestrated");
});

test("approved prose that still requires actual event-shape inspection blocks all-worker admission", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "cleetus-admission-"));
  dirs.push(projectDir);
  const candidate = plan([
    task("t1", "Analyze outcomes", "Edit src/insights/outcomes.ts", ["counts worker outcomes"]),
    task("t2", "Analyze gates", "Edit src/insights/gates.ts", ["groups gate outcomes"]),
    task("t3", "Format report", "Edit src/insights/format.ts", ["formats all metric families"]),
  ]);
  candidate.approvedPlan =
    "Need to inspect the actual event payload structures to determine which fields encode worker completion and verification gates.";

  const report = await analyzeOrchestrationAdmission({ projectDir, plan: candidate });

  expect(approvedPlanHasUnresolvedEvidence(candidate.approvedPlan)).toBe(true);
  expect(report.facts.unresolvedArchitecture).toBe(true);
  expect(report.strategy).toBe("hybrid");
  expect(recommendedAdmissionChoice(report.strategy)).toBe("single");
});
