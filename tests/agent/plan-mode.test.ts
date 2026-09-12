import { describe, expect, it } from "bun:test";
import { classifyTask, isCodingTask } from "../../src/agent/coding-task";
import {
  PLAN_MODE_PROMPT,
  PLAN_MODE_REMINDER,
  approvedPlanStepTitles,
  buildPlanStepPrompt,
  isApprovablePlanResult,
  isMutating,
  isPlanCandidateResult,
  looksLikeApproval,
  looksLikePlanExecutionRequest,
  planModeDenial,
  planRevisionTurnPrompt,
  recoverApprovablePlanContext,
} from "../../src/agent/plan-mode";
import { retrievalEfficiencyKind } from "../../src/agent/retrieval-efficiency";
import { NoneSandbox } from "../../src/sandbox/none";
import { BashTool } from "../../src/tools/bash";
import { EditFileTool } from "../../src/tools/edit-file";
import { GrepTool } from "../../src/tools/grep";
import { MultiEditTool } from "../../src/tools/multi-edit";
import { ReadFileTool } from "../../src/tools/read-file";
import { WriteFileTool } from "../../src/tools/write-file";

describe("isMutating", () => {
  it("is true for the four mutating built-ins", () => {
    expect(isMutating(new EditFileTool())).toBe(true);
    expect(isMutating(new WriteFileTool())).toBe(true);
    expect(isMutating(new MultiEditTool())).toBe(true);
    expect(isMutating(new BashTool(new NoneSandbox("/tmp")))).toBe(true);
  });

  it("is false for read-only tools", () => {
    expect(isMutating(new ReadFileTool())).toBe(false);
    expect(isMutating(new GrepTool())).toBe(false);
  });
});

describe("isApprovablePlanResult", () => {
  const plan =
    "Implementation plan:\n1. Extract the shared state hook and add focused tests.\n2. Wire the alternate renderer and run the full suite.";

  it("accepts a clean plan-shaped response", () => {
    expect(isApprovablePlanResult({ assistantText: plan })).toBe(true);
  });

  it("rejects stopped turns and synthesis/empty fallbacks", () => {
    expect(isApprovablePlanResult({ assistantText: plan, stoppedReason: "stream_watchdog" })).toBe(
      false,
    );
    expect(
      isApprovablePlanResult({
        assistantText:
          "Couldn't produce a plan automatically after repeated blocked tool attempts — try rephrasing, or use a stronger model.",
      }),
    ).toBe(false);
    expect(
      isApprovablePlanResult({
        assistantText: "The model returned an empty response twice. Try again.",
      }),
    ).toBe(false);
  });

  it("rejects generic prose that is not a plan", () => {
    expect(
      isApprovablePlanResult({
        assistantText:
          "I inspected the repository and found several interesting files, but I have not yet decided what implementation should be used.",
      }),
    ).toBe(false);
  });

  it("rejects a plan that copies a stateful controller into a sibling presentation", () => {
    expect(
      isApprovablePlanResult({
        assistantText:
          "Implementation plan:\n1. Copy the inline state block and all handlers from App into AltApp.\n2. Wire AltApp at the render site and test it.",
      }),
    ).toBe(false);
  });

  it("does not treat an options menu or a plan verdict as a persistable plan", () => {
    const options =
      "## Option A — shared hook\n- Move state into one hook.\n\n## Option B — root controller\n- Pass one handler bundle.\n\nRecommendation: Option B.";
    const verdict =
      "The revised plan resolves the fork.\n\n- State remains in App.\n- Handlers remain in App.\n- Both skins use the same bundle.\n\nVerdict: ready to build.";
    expect(isPlanCandidateResult({ assistantText: options })).toBe(false);
    expect(isPlanCandidateResult({ assistantText: verdict })).toBe(false);
    expect(isApprovablePlanResult({ assistantText: verdict })).toBe(false);
  });

  it("accepts a numbered complete replacement plan", () => {
    const replacement =
      "Implementation plan:\n1. Keep the controller in App and expose one typed view/handler bundle.\n2. Move the existing JSX into DefaultSkin and add contract tests.\n3. Build AltSkin over the same bundle and wire the flag.";
    expect(isPlanCandidateResult({ assistantText: replacement })).toBe(true);
    expect(isApprovablePlanResult({ assistantText: replacement })).toBe(true);
  });

  it("accepts numbered steps rendered as Markdown headings or bold labels", () => {
    const bold =
      "Implementation plan:\n**1. Extract shared event decoding**\nAdd the typed seam.\n\n**2. Wire the report**\nAdd focused tests.\n\nAwaiting your approval.";
    const headings =
      "Implementation plan:\n### 1. Extract shared event decoding\nAdd tests.\n### 2. Wire the report\nVerify output.";
    expect(isApprovablePlanResult({ assistantText: bold })).toBe(true);
    expect(isApprovablePlanResult({ assistantText: headings })).toBe(true);
  });

  it("accepts and extracts sequential steps rendered as a Markdown table", () => {
    const table = `Implementation plan:
| # | What | Why |
|---|------|-----|
| **1** | **Set up Bun + TypeScript**<br>\`bun init\` | Establish the project |
| **2** | **Create src/index.ts**<br>Compose the CLI | Implement the entry point |
| **3** | **Run verification**<br>\`bun test\` | Prove behavior |`;
    expect(isPlanCandidateResult({ assistantText: table })).toBe(true);
    expect(isApprovablePlanResult({ assistantText: table })).toBe(true);
    expect(approvedPlanStepTitles(table)).toEqual([
      "Set up Bun + TypeScript",
      "Create src/index.ts",
      "Run verification",
    ]);
  });
});

describe("plan-mode strings", () => {
  it("denial names the blocked tool and steers toward planning", () => {
    const msg = planModeDenial("edit_file");
    expect(msg).toContain("edit_file");
    expect(msg.toLowerCase()).toContain("plan mode");
  });

  it("prompt instructs read-only investigation + a plan", () => {
    expect(PLAN_MODE_PROMPT.toUpperCase()).toContain("PLAN MODE");
    expect(PLAN_MODE_PROMPT.toLowerCase()).toContain("read-only");
    expect(PLAN_MODE_PROMPT).toContain("behavior fork");
    expect(PLAN_MODE_PROMPT).toContain("direct producer and consumer callsites");
    expect(PLAN_MODE_PROMPT).toContain("label the fact unresolved");
  });

  it("turns a selected repair option into a complete replacement-plan request", () => {
    const prompt = planRevisionTurnPrompt("Go with option B");
    expect(prompt).toContain("Go with option B");
    expect(prompt).toContain("complete revised replacement plan");
    expect(prompt).toContain("do not return only a confirmation");
  });

  it("PLAN_MODE_REMINDER wraps the plan-mode guidance in a system-reminder envelope", () => {
    expect(PLAN_MODE_REMINDER.startsWith("<system-reminder>")).toBe(true);
    expect(PLAN_MODE_REMINDER.endsWith("</system-reminder>")).toBe(true);
    expect(PLAN_MODE_REMINDER).toContain("PLAN MODE");
  });
});

describe("looksLikeApproval", () => {
  it("recognizes short affirmatives (with light punctuation/politeness)", () => {
    for (const t of [
      "go",
      "Go for it",
      "go for it!",
      "go ahead",
      "yes",
      "yes please",
      "do it",
      "approved",
      "approve",
      "proceed",
      "ship it",
      "lgtm",
      "apply it",
      "apply the patches",
      "ok go",
      "  GO FOR IT.  ",
    ]) {
      expect(looksLikeApproval(t)).toBe(true);
    }
  });

  it("recognizes explicit plan-execution wording only in the plan-specific helper", () => {
    expect(looksLikeApproval("Implement the plan please")).toBe(false);
    expect(looksLikePlanExecutionRequest("Implement the plan please")).toBe(true);
    expect(looksLikePlanExecutionRequest("Execute the approved plan.")).toBe(true);
    expect(looksLikePlanExecutionRequest("Start implementation")).toBe(true);
    expect(looksLikePlanExecutionRequest("Implement the plan and make the header blue")).toBe(
      false,
    );
  });

  it("recovers only an approvable plan from history", () => {
    const context = {
      request: "Build the feature",
      prosePlan:
        "Plan:\n1. Add the parser and focused tests.\n2. Wire the CLI and run verification.",
    };
    expect(recoverApprovablePlanContext(context)).toEqual(context);
    expect(
      recoverApprovablePlanContext({
        request: "Build the feature",
        prosePlan: "I am still considering a few approaches.",
      }),
    ).toBeNull();
  });

  it("does NOT match messages that carry new instructions or questions", () => {
    for (const t of [
      "go to the about page",
      "yes, but also make the header blue",
      "apply the dark theme to the header",
      "is there a problem applying the patches?",
      "I'd like to add a couple of features",
      "do it differently this time and add tests",
      "",
      "no",
    ]) {
      expect(looksLikeApproval(t)).toBe(false);
    }
  });
});

describe("buildPlanStepPrompt", () => {
  const plan = "Plan:\n1. Skeleton\n2. Wire input\n3. Connect Ollama";
  const steps = ["Skeleton", "Wire input", "Connect Ollama"];

  it("scopes the turn to one step and names it with its number", () => {
    const p = buildPlanStepPrompt(plan, steps, 1);
    expect(p).toContain("Implement step 2 of 3");
    expect(p).toContain("ONLY this step");
    expect(p).toContain("do not begin any later step");
    expect(p).toContain("Now implement step 2: Wire input");
    expect(p).toContain("2. Wire input");
    expect(p).not.toContain("3. Connect Ollama");
  });

  it("marks the first step as first and lists no completed steps", () => {
    const p = buildPlanStepPrompt(plan, steps, 0);
    expect(p).toContain("this is the first step");
    expect(p).toContain("Implement step 1 of 3");
  });

  it("lists completed steps and flags the final step", () => {
    const p = buildPlanStepPrompt(plan, steps, 2);
    expect(p).toContain("1. Skeleton");
    expect(p).toContain("2. Wire input");
    expect(p).toContain("This is the final step");
  });

  it("leads with an imperative so the step turn classifies as coding, not a data artifact", () => {
    // A step prompt must not read as data-artifact export work — that misfires the retrieval flow
    // and closes tools mid-build. Even when the embedded plan mentions markdown/reports, the turn
    // must classify as coding with no retrieval kind.
    const artifactHeavyPlan =
      "Plan:\n1. Skeleton\n2. Render assistant messages with full markdown\n3. Export a report";
    const p = buildPlanStepPrompt(artifactHeavyPlan, ["Skeleton", "Markdown", "Report"], 1);
    expect(isCodingTask(p)).toBe(true);
    expect(classifyTask(p)).not.toBe("artifact");
    expect(retrievalEfficiencyKind(p)).toBeNull();
  });
});
