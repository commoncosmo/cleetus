import { describe, expect, it } from "bun:test";
import { buildPromptOptions, offerOrchestrateAfterPlan } from "../../src/agent/plan-or-go";

describe("buildPromptOptions", () => {
  const base = { mode: "normal" as const, orchestrationAvailable: true, planOrGoEnabled: true };

  it("shows Orchestrate for an explicit build when orchestration is available", () => {
    expect(buildPromptOptions({ ...base, text: "build a web app for users" })).toEqual({
      show: true,
      showOrchestrate: true,
    });
  });

  it("shows the prompt WITHOUT Orchestrate for a non-explicit coding task", () => {
    expect(buildPromptOptions({ ...base, text: "fix the bug in auth.ts" })).toEqual({
      show: true,
      showOrchestrate: false,
    });
  });

  it("never offers Orchestrate for 'create a list' (the whole point)", () => {
    const d = buildPromptOptions({
      ...base,
      text: "create a list of starfleet captains as a table",
    });
    expect(d.showOrchestrate).toBe(false);
  });

  it("hides Orchestrate when orchestration is unavailable, even for an explicit build", () => {
    expect(
      buildPromptOptions({ ...base, orchestrationAvailable: false, text: "build a web app" }),
    ).toEqual({
      show: true,
      showOrchestrate: false,
    });
  });

  it("still shows Orchestrate for an explicit build when plan-or-go is disabled", () => {
    expect(
      buildPromptOptions({ ...base, planOrGoEnabled: false, text: "build a REST API" }),
    ).toEqual({
      show: true,
      showOrchestrate: true,
    });
  });

  it("shows nothing for a non-coding task", () => {
    expect(buildPromptOptions({ ...base, text: "what time is it?" })).toEqual({
      show: false,
      showOrchestrate: false,
    });
  });

  it("shows nothing outside normal mode", () => {
    expect(buildPromptOptions({ ...base, mode: "plan", text: "build a web app" })).toEqual({
      show: false,
      showOrchestrate: false,
    });
  });
});

describe("offerOrchestrateAfterPlan", () => {
  it("offers the orchestrate/go choice when orchestration is enabled", () => {
    expect(offerOrchestrateAfterPlan(true)).toBe(true);
  });

  it("does not offer it when orchestration is disabled", () => {
    expect(offerOrchestrateAfterPlan(false)).toBe(false);
  });
});
