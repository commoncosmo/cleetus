import { expect, test } from "bun:test";
import type { OrchestrationPlan } from "../../../src/agent/orchestrator";
import {
  admissionRevisionPlan,
  orchestrationStartTransition,
  structureOrchestrationForApproval,
  structuringFailureRevisionPlan,
} from "../../../src/ui/tui/orchestration-start";

const signal = () => new AbortController().signal;

test("an explicit orchestration stops when structuring returns null", async () => {
  let failures = 0;
  const result = await structureOrchestrationForApproval(
    {
      structure: async () => null,
      noticeStructureFailure: () => failures++,
    },
    { request: "build it", prosePlan: "plan", signal: signal() },
  );

  expect(result).toEqual({ kind: "failed" });
  expect(failures).toBe(1);
});

test("a structuring exception stops instead of escaping into a single-agent turn", async () => {
  let failures = 0;
  const result = await structureOrchestrationForApproval(
    {
      structure: async () => {
        throw new Error("provider failed");
      },
      noticeStructureFailure: () => failures++,
    },
    { request: "build it", prosePlan: "plan", signal: signal() },
  );

  expect(result).toEqual({ kind: "failed" });
  expect(failures).toBe(1);
});

test("a valid structured plan is returned for task-list approval", async () => {
  let failures = 0;
  const plan: OrchestrationPlan = {
    objective: "build it",
    brief: "brief",
    location: { kind: "cwd" },
    tasks: [],
  };
  const result = await structureOrchestrationForApproval(
    {
      structure: async () => plan,
      noticeStructureFailure: () => failures++,
    },
    { request: "build it", prosePlan: "plan", signal: signal() },
  );

  expect(result).toEqual({ kind: "ready", plan });
  expect(failures).toBe(0);
});

test("an aborted structuring attempt stays quiet", async () => {
  let failures = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await structureOrchestrationForApproval(
    {
      structure: async () => null,
      noticeStructureFailure: () => failures++,
    },
    { request: "build it", prosePlan: "plan", signal: controller.signal },
  );

  expect(result).toEqual({ kind: "cancelled" });
  expect(failures).toBe(0);
});

test("the execution choice remains open until the user approves a ready task list", () => {
  expect(orchestrationStartTransition("ready")).toEqual({
    preserveExecutionChoice: true,
    retry: false,
  });
  expect(orchestrationStartTransition("failed")).toEqual({
    preserveExecutionChoice: true,
    retry: true,
  });
  expect(orchestrationStartTransition("cancelled")).toEqual({
    preserveExecutionChoice: true,
    retry: false,
  });
});

test("admission feedback produces a bounded decomposition-repair prompt", () => {
  const revised = admissionRevisionPlan("Original approved plan", {
    strategy: "hybrid",
    confidence: 0.7,
    score: 2,
    summary: "stage it",
    reasons: ["disjoint files"],
    risks: ["acceptance is vague"],
    facts: {
      implementationTasks: 4,
      exploreTasks: 1,
      tasksWithFocusedAcceptance: 1,
      tasksWithoutNamedFiles: 0,
      referencedFiles: [],
      sharedFiles: [],
      largeSharedFiles: [],
      subjectiveVisualWork: false,
      unresolvedArchitecture: true,
      stagedDiscovery: false,
      mechanicalWork: false,
    },
  });

  expect(revised).toContain("Original approved plan");
  expect(revised).toContain("acceptance is vague");
  expect(revised).toContain("one replacement task list");
  expect(revised).toContain("does not change product scope");
});

test("structuring failure evidence is retained and can ground one repair attempt", async () => {
  const failure = {
    reason: 'task "verify" contains "bun test passes"',
    attempts: 2,
    repeated: true,
  };
  const result = await structureOrchestrationForApproval(
    {
      structure: async () => null,
      getLastStructureFailure: () => failure,
      noticeStructureFailure: () => {},
    },
    { request: "build it", prosePlan: "plan", signal: signal() },
  );

  expect(result).toEqual({ kind: "failed", failure });
  const repair = structuringFailureRevisionPlan("Original plan", failure);
  expect(repair).toContain("Original plan");
  expect(repair).toContain("bun test passes");
  expect(repair).toContain("after 2 model call(s)");
  expect(repair).toContain("does not change product scope");
});
