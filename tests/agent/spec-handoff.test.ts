import { describe, expect, it } from "bun:test";
import {
  buildDirectBuildObjective,
  buildSpecPlanPrompt,
  buildSpecRevisionPrompt,
  composeReviewedSpecPlan,
  matchSpecHandoff,
  resolveSpecExecutionAction,
  specRequiresArchitectureReview,
  writtenSpec,
} from "../../src/agent/spec-handoff";

const MANDATED =
  "Spec written to `docs/specs/2026-07-15-alt-tui.md`. Want me to build it? — reply `review` " +
  "(review it first), `orchestrate` (multi-step build), or `go` (just start).";

describe("matchSpecHandoff", () => {
  it("hits the mandated handoff and extracts the path", () => {
    expect(matchSpecHandoff(MANDATED)).toEqual({ specPath: "docs/specs/2026-07-15-alt-tui.md" });
  });
  it("hits a paraphrase that keeps the anchor + three option words + a path", () => {
    const p =
      "I saved the spec to `docs/specs/x.md`. Want me to build it? You can reply review, " +
      "orchestrate, or go.";
    expect(matchSpecHandoff(p)).toEqual({ specPath: "docs/specs/x.md" });
  });
  it("hits a review/go handoff when orchestration is unavailable", () => {
    expect(
      matchSpecHandoff(
        "Spec written to `docs/specs/x.md`. Want me to build it? reply review or go.",
      ),
    ).toEqual({ specPath: "docs/specs/x.md" });
  });
  it("misses a framing/draft turn with no anchor", () => {
    expect(matchSpecHandoff("What are the key constraints and success criteria?")).toBeNull();
  });
  it("misses unrelated prose containing only one option word", () => {
    expect(matchSpecHandoff("Let's go with the dark theme.")).toBeNull();
  });
  it("misses when the anchor+words are present but there is no backtick path", () => {
    expect(matchSpecHandoff("Want me to build it? reply plan, orchestrate, or go.")).toBeNull();
  });
  it("hits a plan/orchestrate/go handoff — the vocabulary new playbooks emit", () => {
    expect(
      matchSpecHandoff(
        "Spec written to `docs/specs/x.md`. Want me to build it? reply plan, orchestrate, or go.",
      ),
    ).toEqual({ specPath: "docs/specs/x.md" });
  });
});

describe("host-owned spec checkpoints", () => {
  it("detects a written spec even when the model forgets the execution handoff", () => {
    expect(
      writtenSpec({
        assistantText:
          "Spec written to docs/specs/orchestration-health.md. Anything you want changed before I offer the handoff?",
        editedPaths: ["docs/specs/orchestration-health.md"],
      }),
    ).toEqual({ specPath: "docs/specs/orchestration-health.md" });
  });

  it("bounds revision instructions to the spec artifact and forbids implementation", () => {
    const prompt = buildSpecRevisionPrompt("docs/specs/x.md", "Tighten the empty state");
    expect(prompt).toContain("docs/specs/x.md");
    expect(prompt).toContain("Tighten the empty state");
    expect(prompt).toContain("Do not implement product code");
    expect(prompt).toContain("host will present the execution choices");
  });
});

describe("spec review context", () => {
  it("injects the approved spec into review and preserves it beside the resulting plan", () => {
    const spec = "# Alt TUI\n\nRequirement: --tui alt must launch.";
    const prompt = buildSpecPlanPrompt("docs/specs/alt.md", spec);
    expect(prompt).toContain("already-approved");
    expect(prompt).toContain("behavior fork");
    expect(prompt).toContain(spec);
    // Plan-shape guidance: walking skeleton first, vertical slices, capped step count.
    expect(prompt).toContain("walking skeleton");
    expect(prompt).toContain("VERTICAL slice");
    expect(prompt).toContain("at most 5 numbered steps");
    expect(prompt).toContain("stopping after ANY step still leaves a working");
    const composed = composeReviewedSpecPlan(
      "docs/specs/alt.md",
      spec,
      "Implementation plan:\n1. add dispatch\n2. smoke test",
    );
    expect(composed).toContain(spec);
    expect(composed).toContain("Plan-mode implementation review");
  });

  it("requires review when a spec explicitly permits cloning stateful behavior", () => {
    const risk = specRequiresArchitectureReview(
      "AltApp replicates the same state shape and copies the inline handlers from App.",
    );
    expect(risk).toContain("shared controller/composition seam");
  });

  it("does not flag an explicit prohibition on copying handlers", () => {
    expect(
      specRequiresArchitectureReview(
        "Never copy handlers into AltApp; both presentations consume a shared controller.",
      ),
    ).toBeNull();
  });

  it("does not invert a plan that says nothing stateful is duplicated", () => {
    expect(
      specRequiresArchitectureReview(
        "No controller logic crosses the boundary; nothing stateful is duplicated.",
      ),
    ).toBeNull();
  });

  it("does not invert passive negation", () => {
    expect(
      specRequiresArchitectureReview("Controller state is not copied into the sibling shell."),
    ).toBeNull();
  });

  it("does not flag the negated and explanatory sentences seen in plan review", () => {
    for (const text of [
      "Calls useCleetusApp(props) — the same hook, no controller copy.",
      "No useState or handler is duplicated.",
      "This resolves the fork: there is one controller and zero duplicated state or handlers.",
      "The naive approach copies controller state and would be a behavior fork.",
      "Keep completion in one shared helper so neither skin duplicates controller behavior.",
      "Why not a second `App` copy: that would fork 40 `useState`/`useRef` hooks and every handler — a behavior fork explicitly forbidden by the spec.",
    ]) {
      expect(specRequiresArchitectureReview(text)).toBeNull();
    }
  });

  it("retains the spec path when the body could not be read", () => {
    expect(composeReviewedSpecPlan("docs/specs/alt.md", "", "Plan: 1. inspect 2. build")).toContain(
      "Approved spec path: docs/specs/alt.md",
    );
  });
});

describe("resolveSpecExecutionAction", () => {
  it("honors an explicit go as a direct build even when an architecture seam remains", () => {
    expect(resolveSpecExecutionAction("go", "copies a stateful controller into a sibling")).toEqual(
      { kind: "direct", guardrail: "copies a stateful controller into a sibling" },
    );
    expect(resolveSpecExecutionAction("go", null)).toEqual({ kind: "direct", guardrail: null });
  });
  it("forces one planning pass before orchestration only when a seam remains", () => {
    expect(resolveSpecExecutionAction("orchestrate", "seam")).toEqual({
      kind: "orchestrate-plan",
    });
    expect(resolveSpecExecutionAction("orchestrate", null)).toEqual({ kind: "orchestrate" });
  });
  it("always plans when the user asked to plan", () => {
    expect(resolveSpecExecutionAction("plan", "seam")).toEqual({ kind: "plan" });
    expect(resolveSpecExecutionAction("plan", null)).toEqual({ kind: "plan" });
  });
});

describe("buildDirectBuildObjective", () => {
  it("returns the bare objective when there is no architecture risk", () => {
    expect(buildDirectBuildObjective("Implement the approved spec.", null)).toBe(
      "Implement the approved spec.",
    );
  });
  it("folds an architecture guardrail into the objective when a risk is carried forward", () => {
    const objective = buildDirectBuildObjective("Implement the approved spec.", "shared seam risk");
    expect(objective).toContain("Implement the approved spec.");
    expect(objective).toContain("Architecture guardrail before you build: shared seam risk");
    expect(objective).toContain("behavior fork");
  });
});
