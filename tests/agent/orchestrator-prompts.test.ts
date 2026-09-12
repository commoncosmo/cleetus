import { describe, expect, it, test } from "bun:test";
import {
  type PlanTask,
  composeWorkerPrompt,
  dedupeDoneEntries,
  renderOrchestrationOutcome,
} from "../../src/agent/orchestrator";
import {
  CLOSING_SYSTEM,
  REPLAN_SYSTEM,
  STRUCTURE_SYSTEM,
  closingUser,
  replanUser,
  structureUser,
  withSkillGuidance,
  withUserInstructions,
} from "../../src/agent/orchestrator-prompts";

test("withUserInstructions appends the emphasis-wrapped instructions to the base", () => {
  const out = withUserInstructions(STRUCTURE_SYSTEM, "prefer Bun over npm");
  expect(out).toContain(STRUCTURE_SYSTEM);
  expect(out).toContain("prefer Bun over npm");
  expect(out).toContain("take precedence");
});

test("withUserInstructions returns the base unchanged when instructions are empty", () => {
  expect(withUserInstructions(STRUCTURE_SYSTEM, "")).toBe(STRUCTURE_SYSTEM);
  expect(withUserInstructions(REPLAN_SYSTEM, "   ")).toBe(REPLAN_SYSTEM);
});

const done: PlanTask[] = [
  {
    id: "t1",
    title: "Scaffold",
    description: "make project",
    agentType: "general",
    status: "done",
  },
];
const pending: PlanTask[] = [
  { id: "t2", title: "Wire UI", description: "build ui", agentType: "general", status: "pending" },
];

test("system prompts demand a json object with tasks", () => {
  for (const p of [STRUCTURE_SYSTEM, REPLAN_SYSTEM]) {
    expect(p.toLowerCase()).toContain("json");
    expect(p).toContain("tasks");
    expect(p).toContain("acceptance");
  }
});

test("structureUser embeds the request and the approved plan", () => {
  const u = structureUser("Build a desk app", "1. scaffold\n2. wire ui", "");
  expect(u).toContain("Build a desk app");
  expect(u).toContain("wire ui");
});

test("structureUser prepends a pre-rendered location anchor when one is given", () => {
  const u = structureUser(
    "Build a desk app",
    "1. scaffold",
    "The project already exists at /home/me/proj.",
  );
  expect(u).toContain("/home/me/proj");
  expect(u).toMatch(/already exists/i);
});

test("structureUser omits the anchor block when the locationAnchor is empty", () => {
  const u = structureUser("Build a desk app", "1. scaffold", "");
  expect(u).not.toMatch(/already exists/i);
  expect(u.startsWith("Original request:")).toBe(true);
});

test("STRUCTURE_SYSTEM forbids inventing a new top-level/root project folder", () => {
  const s = STRUCTURE_SYSTEM.toLowerCase();
  expect(s).toMatch(/top-level|root folder/);
  expect(s).toContain("already exists");
});

test("STRUCTURE_SYSTEM splits monolithic state-and-render refactors", () => {
  expect(STRUCTURE_SYSTEM).toContain("500+ line component");
  expect(STRUCTURE_SYSTEM).toMatch(/state\/behavior.*rendering/i);
  expect(STRUCTURE_SYSTEM).toMatch(/separate task/i);
});

test("replanUser embeds the frozen objective, brief, finished task, its result, and remaining work", () => {
  const u = replanUser(
    "Add a nav item and a page",
    "The brief",
    done[0]!,
    "scaffold output",
    pending,
    "",
    "",
  );
  expect(u).toContain("Add a nav item and a page");
  expect(u).toContain("The brief");
  expect(u).toContain("Scaffold");
  expect(u).toContain("scaffold output");
  expect(u).toContain("Wire UI");
});

test("replanUser carries a frozen prior acceptance ledger", () => {
  const prior: PlanTask = {
    id: "t1",
    title: "Theme dispatch",
    description: "wire the alternate theme",
    agentType: "general",
    status: "failed",
    acceptanceCriteria: ['resolveTuiTheme("alt") returns themes.alt'],
  };
  const text = replanUser("request", "brief", prior, "failed", [], "", "", [prior]);
  expect(text).toContain("FROZEN PRIOR ACCEPTANCE LEDGER");
  expect(text).toContain('resolveTuiTheme("alt") returns themes.alt');
  expect(text).toContain("must never contradict, remove, or weaken");
});

test("REPLAN_SYSTEM anchors to the original request and biases against unrequested additions", () => {
  expect(REPLAN_SYSTEM).toMatch(/scope boundary/i);
  expect(REPLAN_SYSTEM).toMatch(/add only/i);
  expect(REPLAN_SYSTEM).toMatch(/patch the existing remaining plan/i);
  expect(REPLAN_SYSTEM).toMatch(/must not weaken.*acceptance criteria/i);
});

test("closingUser lists completed and failed tasks", () => {
  const u = closingUser("The brief", [
    done[0]!,
    { id: "t2", title: "Wire UI", description: "x", agentType: "general", status: "failed" },
  ]);
  expect(u).toContain("Scaffold");
  expect(u).toContain("Wire UI");
  expect(CLOSING_SYSTEM.length).toBeGreaterThan(0);
});

test("withSkillGuidance appends guidance when non-empty", () => {
  expect(withSkillGuidance("BASE", "GUIDE")).toBe("BASE\n\nGUIDE");
});

test("withSkillGuidance returns base unchanged when guidance empty", () => {
  expect(withSkillGuidance("BASE", "")).toBe("BASE");
});

test("STRUCTURE_SYSTEM instructs coarse task granularity (C2)", () => {
  expect(STRUCTURE_SYSTEM).toContain("meaningful unit of work");
  expect(STRUCTURE_SYSTEM).toMatch(/3.?8 tasks/); // "3-8 tasks" / "3–8 tasks"
});

test("STRUCTURE_SYSTEM avoids redundant inventory when the approved plan already has details", () => {
  expect(STRUCTURE_SYSTEM).toContain("Do not create a standalone inventory/exploration task");
  expect(STRUCTURE_SYSTEM).toContain("concrete finding explicit");
});

test("STRUCTURE_SYSTEM preserves strong requirements and gives files to implementation tasks", () => {
  expect(STRUCTURE_SYSTEM).toContain("Explicit requirements and acceptance criteria outrank");
  expect(STRUCTURE_SYSTEM).toContain(
    "must not be treated as the owner of implementation or test files",
  );
});

test("visual task acceptance requires rendered evidence", () => {
  expect(STRUCTURE_SYSTEM).toContain("rendered output or snapshots");
  expect(STRUCTURE_SYSTEM).toContain("no-throw test");
  expect(STRUCTURE_SYSTEM).toContain("registration callbacks are reachable");
  expect(STRUCTURE_SYSTEM).toContain("more than three UI components is too large");
});

test("leaf tasks cannot own integration gates or baseline mutation", () => {
  expect(STRUCTURE_SYSTEM).toContain("Leaf-task acceptance MUST use focused tests");
  expect(STRUCTURE_SYSTEM).toContain("do not create a final verification-only task");
  expect(STRUCTURE_SYSTEM).toContain("Never tell a worker to use git stash, checkout, or reset");
});

describe("composeWorkerPrompt artifacts", () => {
  const base = {
    anchor: "",
    onDiskSnapshot: "",
    taskDescription: "do X",
    upcomingTitles: [],
    brief: "B",
  };
  it("renders a done entry with its files", () => {
    const out = composeWorkerPrompt({
      ...base,
      doneEntries: [
        { title: "Implement nextMode", status: "done", files: ["src/ui/tui/alt/context-logic.ts"] },
      ],
    });
    expect(out).toContain("✓ Implement nextMode → src/ui/tui/alt/context-logic.ts");
  });
  it("renders a done entry with no files as bare title", () => {
    const out = composeWorkerPrompt({
      ...base,
      doneEntries: [{ title: "Read spec", status: "done", files: [] }],
    });
    expect(out).toContain("✓ Read spec");
    expect(out).not.toContain("→");
  });
  it("carries a read-only task's actual findings into the next worker prompt", () => {
    const out = composeWorkerPrompt({
      ...base,
      doneEntries: [
        {
          title: "Map TUI exports",
          status: "done",
          files: [],
          summary: "AppProps is exported from src/ui/tui/app.tsx; render site is line 662.",
        },
      ],
    });
    expect(out).toContain("Handoff:");
    expect(out).toContain("AppProps is exported from src/ui/tui/app.tsx");
  });
  it("carries completed acceptance constraints into later workers", () => {
    const out = composeWorkerPrompt({
      ...base,
      doneEntries: [
        {
          title: "Create shared seam",
          status: "done",
          files: ["src/ui/controller.ts"],
          acceptance: ["Both roots consume the exact shared AppProps contract"],
        },
      ],
    });
    expect(out).toContain("Preserve these established constraints");
    expect(out).toContain("Both roots consume the exact shared AppProps contract");
  });
  it("caps at 6 files with +N more", () => {
    const files = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
    const out = composeWorkerPrompt({
      ...base,
      doneEntries: [{ title: "T", status: "done", files }],
    });
    expect(out).toContain("(+2 more)");
  });
  it("labels partial and failed outcomes honestly", () => {
    const out = composeWorkerPrompt({
      ...base,
      doneEntries: [
        { title: "Wire CLI", status: "partial", files: ["src/bin/cleetus.ts"] },
        { title: "Build root", status: "failed", files: [] },
      ],
    });
    expect(out).toContain("◐ Wire CLI → src/bin/cleetus.ts (partial — inspect before continuing)");
    expect(out).toContain("✗ Build root (failed)");
    expect(out).not.toContain("✓ Wire CLI");
    expect(out).not.toContain("✓ Build root");
  });
});

describe("renderOrchestrationOutcome", () => {
  const task = (over: Partial<import("../../src/agent/orchestrator").PlanTask>) =>
    ({
      id: "t1",
      title: "T",
      description: "d",
      agentType: "general",
      status: "done",
      ...over,
    }) as import("../../src/agent/orchestrator").PlanTask;

  it("first-person header, ✓ with files, ✗ incomplete, and a tally with not-reached", () => {
    const out = renderOrchestrationOutcome(
      [
        task({ title: "Wire --tui flag", status: "done", producedFiles: ["src/bin/cleetus.ts"] }),
        task({ title: "Alt App layout", status: "failed" }),
      ],
      3,
    );
    expect(out).toContain("I built this via orchestrated workers:");
    expect(out).toContain("✓ Wire --tui flag → src/bin/cleetus.ts");
    expect(out).toContain("✗ Alt App layout — incomplete (stopped without converging)");
    expect(out).toContain("1 of 5 task(s) completed; 3 not reached.");
  });
  it("a completed task with no files renders a bare ✓ line", () => {
    const out = renderOrchestrationOutcome([task({ title: "Read spec", producedFiles: [] })], 0);
    expect(out).toContain("✓ Read spec");
    expect(out).not.toContain("→");
    expect(out).toContain("1 of 1 task(s) completed.");
  });
  it("caps at 6 files with +N more", () => {
    const files = Array.from({ length: 8 }, (_, i) => `f${i}.ts`);
    const out = renderOrchestrationOutcome([task({ producedFiles: files })], 0);
    expect(out).toContain("(+2 more)");
  });
  it("all-failed plan renders 0 completed", () => {
    const out = renderOrchestrationOutcome(
      [task({ status: "failed" }), task({ id: "t2", status: "failed" })],
      0,
    );
    expect(out).toContain("0 of 2 task(s) completed.");
  });
  it("renders partial tasks with their landed files without counting them complete", () => {
    const out = renderOrchestrationOutcome(
      [task({ status: "partial", producedFiles: ["src/bin/cleetus.ts"] })],
      0,
    );
    expect(out).toContain("◐ T → src/bin/cleetus.ts — partial");
    expect(out).toContain("0 of 1 task(s) completed.");
  });
});

describe("dedupeDoneEntries", () => {
  it("collapses a Retry: duplicate, unioning files", () => {
    const out = dedupeDoneEntries([
      { title: "Implement contextRemaining", status: "done", files: ["a.ts"] },
      { title: "Retry: Implement contextRemaining", status: "partial", files: ["a.ts", "b.ts"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.files.sort()).toEqual(["a.ts", "b.ts"]);
    expect(out[0]!.status).toBe("partial");
  });
  it("keeps distinct titles", () => {
    const out = dedupeDoneEntries([
      { title: "A", status: "done", files: [] },
      { title: "B", status: "failed", files: [] },
    ]);
    expect(out).toHaveLength(2);
  });
  it("lets a successful retry upgrade an earlier partial outcome", () => {
    const out = dedupeDoneEntries([
      { title: "Wire CLI", status: "partial", files: ["src/bin/cleetus.ts"] },
      { title: "Retry: Wire CLI", status: "done", files: ["src/ui/tui/App.tsx"] },
    ]);
    expect(out).toEqual([
      {
        title: "Wire CLI",
        status: "done",
        files: ["src/bin/cleetus.ts", "src/ui/tui/App.tsx"],
      },
    ]);
  });
});
