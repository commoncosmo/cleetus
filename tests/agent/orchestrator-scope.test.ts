import { expect, test } from "bun:test";
import {
  type PlanTask,
  clampScope,
  computeScopeBudget,
  normalizeStructuredPlan,
  oversizedUiTaskReason,
  planTaskQualityReason,
  reconcileReplan,
  runtimeOwnedGateEvidence,
  taskOwnedPaths,
} from "../../src/agent/orchestrator";

function tasks(n: number): PlanTask[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `task ${i + 1}`,
    description: `do ${i + 1}`,
    agentType: "general" as const,
    status: "pending" as const,
  }));
}

test("computeScopeBudget uses the multiplicative cap for larger plans", () => {
  expect(computeScopeBudget(6, 2)).toBe(12); // max(ceil(6*2)=12, 6+3=9) = 12
});

test("computeScopeBudget uses the floor for tiny plans", () => {
  expect(computeScopeBudget(3, 2)).toBe(6); // max(6, 6) = 6
  expect(computeScopeBudget(1, 2)).toBe(4); // max(2, 4) = 4
});

test("clampScope passes through when proposed work is within budget", () => {
  const { kept, dropped } = clampScope({
    doneCount: 1,
    failedCount: 0,
    proposed: tasks(4),
    scopeBudget: 6,
  });
  expect(kept).toHaveLength(4);
  expect(dropped).toHaveLength(0);
});

test("clampScope drops the tail when proposed work exceeds budget", () => {
  // doneCount 1 + proposed 10 = 11 > budget 6; room = 6 - 1 = 5 → keep 5, drop 5
  const { kept, dropped } = clampScope({
    doneCount: 1,
    failedCount: 0,
    proposed: tasks(10),
    scopeBudget: 6,
  });
  expect(kept).toHaveLength(5);
  expect(dropped).toHaveLength(5);
  expect(kept.map((t) => t.title)).toEqual(["task 1", "task 2", "task 3", "task 4", "task 5"]);
});

test("clampScope raises the ceiling by 1 per failure (corrective work is not truncated)", () => {
  // Same inputs as the drop case, but 2 prior failures → effectiveBudget = 6 + 2 = 8; room = 7
  const { kept, dropped } = clampScope({
    doneCount: 1,
    failedCount: 2,
    proposed: tasks(7),
    scopeBudget: 6,
  });
  expect(kept).toHaveLength(7);
  expect(dropped).toHaveLength(0);
});

test("clampScope drops everything when done already meets the effective budget", () => {
  const { kept, dropped } = clampScope({
    doneCount: 6,
    failedCount: 0,
    proposed: tasks(3),
    scopeBudget: 6,
  });
  expect(kept).toHaveLength(0);
  expect(dropped).toHaveLength(3);
});

test("clampScope: a prior failure raises the ceiling enough to keep one more task", () => {
  // budget 6, doneCount 1 → room 5. Without a failure, 6 proposed → drop 1.
  // With failedCount 1, effectiveBudget 7 → room 6 → all 6 kept, nothing dropped.
  const base = { doneCount: 1, proposed: tasks(6), scopeBudget: 6 };
  expect(clampScope({ ...base, failedCount: 0 }).dropped).toHaveLength(1);
  expect(clampScope({ ...base, failedCount: 1 }).dropped).toHaveLength(0);
});

test("reconcileReplan preserves original tasks omitted by a recovery plan", () => {
  const original = tasks(2);
  const proposed: PlanTask[] = [
    { ...original[1]!, description: "updated second task", status: "pending" },
  ];
  const out = reconcileReplan({ original, proposed, recoveryRoom: 3 });
  expect(out.tasks.map((t) => t.title)).toEqual(["task 2", "task 1"]);
  expect(out.tasks[0]!.description).toBe("updated second task");
  expect(out.added).toBe(0);
});

test("reconcileReplan bounds only new recovery work, never original pending work", () => {
  const original = tasks(2);
  const proposed: PlanTask[] = [
    ...tasks(3).map((t, i) => ({ ...t, id: `r${i}`, title: `repair ${i}` })),
  ];
  const out = reconcileReplan({ original, proposed, recoveryRoom: 1 });
  expect(out.tasks.map((t) => t.title)).toEqual(["repair 0", "task 1", "task 2"]);
  expect(out.dropped.map((t) => t.title)).toEqual(["repair 1", "repair 2"]);
});

test("recovery decomposition inherits the failed parent's acceptance bar", () => {
  const failed: PlanTask = {
    id: "t1",
    title: "Build functional alternate TUI",
    description: "Implement the complete alternate UI",
    agentType: "general",
    status: "failed",
    acceptanceCriteria: ["Alt root renders history, input, footer, and every picker"],
  };
  const proposed: PlanTask[] = [
    {
      id: "r1",
      title: "Explore TUI contract",
      description: "Inspect props",
      agentType: "explore",
      status: "pending",
      acceptanceCriteria: ["Report the props"],
    },
    {
      id: "r2",
      title: "Build minimal shell",
      description: "Render a Box with Text",
      agentType: "general",
      status: "pending",
      acceptanceCriteria: ["A Box renders"],
    },
  ];
  const out = reconcileReplan({ original: [], proposed, recoveryRoom: 2, failedTask: failed });
  expect(out.tasks[0]?.acceptanceCriteria).toEqual(["Report the props"]);
  expect(out.tasks[1]?.acceptanceCriteria).toEqual(["A Box renders"]);
  expect(out.tasks[2]).toMatchObject({
    title: "Retry: Build functional alternate TUI",
    status: "pending",
    acceptanceCriteria: ["Alt root renders history, input, footer, and every picker"],
  });
  expect(out.added).toBe(2);
});

test("replan with no recovery room still retries the failed task without counting it as new scope", () => {
  const failed: PlanTask = {
    ...tasks(1)[0]!,
    title: "Wire the feature",
    status: "failed",
    acceptanceCriteria: ["The entry point reaches the feature"],
  };
  const out = reconcileReplan({ original: [], proposed: [], recoveryRoom: 0, failedTask: failed });
  expect(out.added).toBe(0);
  expect(out.tasks[0]).toMatchObject({
    title: "Retry: Wire the feature",
    status: "pending",
    acceptanceCriteria: ["The entry point reaches the feature"],
  });
});

test("a model-authored parent retry is held behind recovery leaves as the integration spine", () => {
  const failed: PlanTask = {
    ...tasks(1)[0]!,
    title: "Wire alternate TUI",
    description: "Implement and wire the complete alternate TUI",
    status: "failed",
    acceptanceCriteria: ["CLI reaches the alternate root"],
  };
  const proposed: PlanTask[] = [
    {
      ...tasks(1)[0]!,
      id: "leaf",
      title: "Extract shared controller",
      acceptanceCriteria: ["Shared state is reusable"],
    },
    {
      ...failed,
      id: "model-retry",
      title: "Retry: Wire alternate TUI",
      description: "Compose the root and exercise the CLI",
      acceptanceCriteria: ["Runtime smoke passes"],
    },
  ];
  const out = reconcileReplan({ original: [], proposed, recoveryRoom: 1, failedTask: failed });
  expect(out.tasks.map((task) => task.title)).toEqual([
    "Extract shared controller",
    "Retry: Wire alternate TUI",
  ]);
  expect(out.tasks[1]?.acceptanceCriteria).toEqual([
    "Runtime smoke passes",
    "CLI reaches the alternate root",
  ]);
  expect(out.added).toBe(1);
});

test("partial editing recovery drops redundant exploration and caps new recovery leaves", () => {
  const make = (title: string): PlanTask => ({
    ...tasks(1)[0]!,
    title,
    description: `do ${title}`,
  });
  const failed = make("Build alt root");
  failed.status = "partial";
  failed.producedFiles = ["src/ui/alt/app.tsx"];
  const proposed = [
    { ...make("Explore AppProps"), agentType: "explore" as const },
    make("Fix root"),
    make("Fix leaves"),
    make("Add optional smoke harness"),
  ];
  const out = reconcileReplan({ original: [], proposed, recoveryRoom: 8, failedTask: failed });
  expect(out.tasks.map((entry) => entry.title)).toEqual([
    "Fix root",
    "Fix leaves",
    "Retry: Build alt root",
  ]);
  expect(out.dropped.map((entry) => entry.title)).toEqual([
    "Explore AppProps",
    "Add optional smoke harness",
  ]);
});

test("replan drops verification-only recovery tasks and retains the implementation retry", () => {
  const failed: PlanTask = {
    ...tasks(1)[0]!,
    title: "Wire alternate UI",
    description: "wire the complete alternate UI",
    agentType: "general",
    status: "failed",
  };
  const proposed: PlanTask[] = [
    { ...tasks(1)[0]!, title: "Recovery: verify exit-code capture" },
    { ...tasks(1)[0]!, title: "Retry: Final verification with smoke tests" },
  ];

  const out = reconcileReplan({ original: [], proposed, recoveryRoom: 3, failedTask: failed });

  expect(out.tasks.map((task) => task.title)).toEqual(["Retry: Wire alternate UI"]);
  expect(out.dropped.map((task) => task.title)).toEqual([
    "Recovery: verify exit-code capture",
    "Retry: Final verification with smoke tests",
  ]);
});

test("oversized UI task validation catches the codex12 component bundles", () => {
  const make = (title: string): PlanTask => ({
    ...tasks(1)[0]!,
    title,
    description: title,
  });

  expect(
    oversizedUiTaskReason(
      make("Build core alt layout: app, header, transcript, tool-line, reasoning-panel, footer"),
    ),
  ).toContain("split it");
  expect(
    oversizedUiTaskReason(make("Build alt input, status-bar, busy-indicator, and command-panel")),
  ).toContain("split it");
  expect(oversizedUiTaskReason(make("Build all alt picker and prompt modal components"))).toContain(
    "split it",
  );
  expect(oversizedUiTaskReason(make("Build and test the alt composer"))).toBeNull();
});

test("UI compatibility constraints in a description do not become owned surfaces", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    title: "Wire the shared alternate root",
    description:
      "Preserve the model picker, mode picker, route picker, persona picker, permission prompt, restore prompt, and all existing modal behavior.",
  };

  expect(oversizedUiTaskReason(task)).toBeNull();
});

test("an implementation task explicitly owning four UI source paths is oversized", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    title: "Implement the alternate interaction flow",
    description:
      "Create src/ui/a.tsx, src/ui/b.tsx, src/ui/c.tsx, and src/ui/d.tsx with interaction tests.",
  };

  const reason = oversizedUiTaskReason(task);
  expect(reason).toContain("owns 4 UI surfaces");
  expect(reason).toContain("src/ui/d.tsx");
});

test("UI tests and application entrypoints do not inflate component ownership", () => {
  const routerTask: PlanTask = {
    ...tasks(1)[0]!,
    title: "Shared Layout shell + App router + main.tsx entrypoint + router test",
    description:
      "Create src/Layout.tsx and src/App.tsx, wire src/main.tsx, and add src/App.test.tsx.",
  };
  const testTask: PlanTask = {
    ...tasks(1)[0]!,
    title: "Implement three product views with focused tests",
    description:
      "Create src/a.tsx, src/b.tsx, src/c.tsx, and src/c.test.tsx with interaction coverage.",
  };
  const entrypointTask: PlanTask = {
    ...tasks(1)[0]!,
    title: "Wire three components into the application entrypoint",
    description: "Create src/a.tsx, src/b.tsx, src/c.tsx, and src/main.tsx.",
  };

  expect(oversizedUiTaskReason(routerTask)).toBeNull();
  expect(oversizedUiTaskReason(testTask)).toBeNull();
  expect(oversizedUiTaskReason(entrypointTask)).toBeNull();
});

test("plan quality rejects repository-wide gates in leaf acceptance", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    title: "Wire the selection seam",
    description: "Implement the seam, run the focused test, then run bun test.",
    acceptanceCriteria: ["bun test passes with no regressions"],
  };

  expect(planTaskQualityReason(task)).toContain("repository-wide");
});

test("structured tasks carry explicit file ownership into workers", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    description: "Edit src/insights/report.ts and `tests/insights/report.test.ts`.",
    acceptanceCriteria: ["bun test tests/insights/report.test.ts"],
  };
  expect(taskOwnedPaths(task)).toEqual(["src/insights/report.ts", "tests/insights/report.test.ts"]);
});

test("runtime gate evidence reports the exact offending clause", () => {
  expect(
    runtimeOwnedGateEvidence("Counts events, then run bun run typecheck before finishing"),
  ).toBe("bun run typecheck before finishing");
});

test("normalization strips runtime-owned gates while preserving implementation and focused tests", () => {
  const normalized = normalizeStructuredPlan({
    brief: "health analyzers",
    tasks: [
      {
        ...tasks(1)[0]!,
        title: "Implement runtime interventions analyzer",
        description:
          "Implement src/insights/analyzers/runtime-interventions.ts. Then run the full test suite.",
        acceptanceCriteria: [
          "bun test tests/insights/analyzers/runtime-interventions.test.ts",
          "bun run typecheck passes",
        ],
      },
      {
        ...tasks(1)[0]!,
        id: "t2",
        title: "Run full test suite to verify no regressions",
        description: "Run the full test suite.",
        acceptanceCriteria: ["bun test passes"],
      },
    ],
  });

  expect(normalized.plan?.tasks).toHaveLength(1);
  expect(normalized.plan?.tasks[0]?.description).toBe(
    "Implement src/insights/analyzers/runtime-interventions.ts.",
  );
  expect(normalized.plan?.tasks[0]?.acceptanceCriteria).toEqual([
    "bun test tests/insights/analyzers/runtime-interventions.test.ts",
  ]);
  expect(normalized.changes).toHaveLength(2);
});

test("plan quality permits a focused Bun test target", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    title: "Wire the selection seam",
    description: "Implement the seam and run bun test tests/ui/tui/resolve-tui.test.ts.",
    acceptanceCriteria: ["tests/ui/tui/resolve-tui.test.ts passes"],
  };

  expect(planTaskQualityReason(task)).toBeNull();
});

test("plan quality rejects a glm-orch1-sized explore inventory", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    title: "Explore every TUI contract",
    agentType: "explore",
    description: `${"Inspect and report every prop, export, signature, and consumer. ".repeat(24)} (1) AppProps (2) history exports (3) picker exports (4) bin wiring`,
  };

  expect(planTaskQualityReason(task)).toContain("unbounded repository inventory");
});

test("plan quality rejects an explore task that also claims implementation work", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    title: "Explore event data and scaffold foundation",
    agentType: "explore",
    description: "Inspect event payloads, then create the analyzer foundation.",
    acceptanceCriteria: ["Document the event shapes"],
  };

  expect(planTaskQualityReason(task)).toContain("mixes read-only discovery with implementation");
});

test("complex transcript and composer surfaces must be separate tasks", () => {
  const task: PlanTask = {
    ...tasks(1)[0]!,
    title: "Build message-log header and footer",
    description: "Implement the alternate conversation surface.",
  };

  expect(planTaskQualityReason(task)).toContain("split it");
});

test("replan drops exploration after any earlier implementation artifact landed", () => {
  const failed: PlanTask = {
    ...tasks(1)[0]!,
    title: "Finish composer",
    status: "failed",
  };
  const explore: PlanTask = {
    ...tasks(1)[0]!,
    title: "Recovery: inspect current on-disk state",
    agentType: "explore",
  };

  const result = reconcileReplan({
    original: [],
    proposed: [explore],
    recoveryRoom: 2,
    failedTask: failed,
    hasLandedArtifacts: true,
  });

  expect(result.dropped.map((task) => task.title)).toContain(explore.title);
});
