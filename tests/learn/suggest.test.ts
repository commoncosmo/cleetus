import { describe, expect, it } from "bun:test";
import { playbookSuggestionText, shouldSuggestPlaybook } from "../../src/learn/suggest";

describe("learned-playbook suggestion", () => {
  it("suggests after repeated executed-tool failures followed by useful success", () => {
    const result = {
      successfulToolCalls: 2,
      failedToolCalls: 2,
    };
    expect(shouldSuggestPlaybook(result)).toBe(true);
    expect(playbookSuggestionText(result)).toContain("2 unsuccessful tool attempts");
    expect(playbookSuggestionText(result)).toContain("/learn");
  });

  it("does not suggest for one transient failure, failure-only churn, or stopped turns", () => {
    expect(shouldSuggestPlaybook({ successfulToolCalls: 4, failedToolCalls: 1 })).toBe(false);
    expect(shouldSuggestPlaybook({ successfulToolCalls: 0, failedToolCalls: 5 })).toBe(false);
    expect(
      shouldSuggestPlaybook({
        successfulToolCalls: 3,
        failedToolCalls: 2,
        stoppedReason: "cancelled",
      }),
    ).toBe(false);
  });

  it("counts objectively empty retrievals without calling them tool failures", () => {
    const result = {
      successfulToolCalls: 5,
      failedToolCalls: 0,
      unproductiveToolCalls: 3,
    };
    expect(shouldSuggestPlaybook(result)).toBe(true);
    expect(playbookSuggestionText(result)).toContain("3 unsuccessful tool attempts");
  });
});
