import { describe, expect, it } from "bun:test";
import {
  currentTurnEvidence,
  groundedSynthesisMessages,
  synthesisGroundingIssues,
} from "../../src/agent/grounded-synthesis";
import type { Message } from "../../src/providers/types";

describe("grounded synthesis", () => {
  it("keeps only current-turn tool observations and drops assistant narration", () => {
    const messages: Message[] = [
      { role: "user", content: "old request" },
      {
        role: "assistant",
        content: "old narration",
        toolCalls: [{ id: "old", name: "web_fetch", args: {} }],
      },
      { role: "tool", toolCallId: "old", content: "old result" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current request" },
      {
        role: "assistant",
        content: "I reckon I will invent a date",
        toolCalls: [{ id: "new", name: "web_fetch", args: {} }],
      },
      { role: "tool", toolCallId: "new", content: "Today: July 23, high 77°F" },
    ];

    const evidence = currentTurnEvidence(messages, 4);

    expect(evidence).toContain('name="web_fetch"');
    expect(evidence).toContain("July 23");
    expect(evidence).not.toContain("old result");
    expect(evidence).not.toContain("I reckon");
  });

  it("flags unsupported quantified claims and explicit bullet-count drift", () => {
    const issues = synthesisGroundingIssues(
      "Summarize the forecast in three bullets.",
      "- Today is July 7, 2026 and 77°F.\n- Dry.",
      "Generated July 23, 2026. High 77°F.",
    );

    expect(issues).toContain("requested 3 bullets but draft has 2");
    expect(issues.some((issue) => issue.includes("July 7, 2026"))).toBe(true);
    expect(issues.some((issue) => issue.includes("77°F"))).toBe(false);
  });

  it("allows fuzzy converted summaries but flags unsupported completeness claims", () => {
    expect(
      synthesisGroundingIssues(
        "Summarize the forecast.",
        "Temperatures climb into the mid-90s after conversion from Celsius.",
        "maximum_temperature_2m: 35.2 C",
      ),
    ).toEqual([]);

    expect(
      synthesisGroundingIssues(
        "Retrieve the response and save it as data.json.",
        "Saved the full response to data.json.",
        "wrote 100 bytes to data.json",
      ),
    ).toContain("draft claims a complete artifact without exact or structural fidelity evidence");
  });

  it("recognizes number and unit pairs represented by structured JSON fields", () => {
    const evidence = `<tool-observation name="web_fetch">
<untrusted-web-content url="https://example.test/forecast">
{"properties":{"periods":[{"temperature":75,"temperatureUnit":"F","probabilityOfPrecipitation":{"unitCode":"wmoUnit:percent","value":0}}]}}
</untrusted-web-content>
</tool-observation>`;

    expect(
      synthesisGroundingIssues(
        "Summarize the forecast in two bullets.",
        "- The high is 75°F.\n- Precipitation probability is 0%.",
        evidence,
      ),
    ).toEqual([]);
    expect(
      synthesisGroundingIssues(
        "Summarize the forecast in one bullet.",
        "- The high is 79°F.",
        evidence,
      ),
    ).toContain("unsupported quantified claims: 79°F");
  });

  it("builds an isolated final request with the exact current contract and evidence", () => {
    const messages = groundedSynthesisMessages({
      systemPrompt: "voice",
      request: "Do not create files. Return three bullets.",
      evidence: "The forecast high is 77°F.",
      draft: "Saved forecast.json.",
      issues: ["requested 3 bullets but draft has 0"],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "system", content: "voice" });
    expect(messages[1]!.content).toContain("<current-request>");
    expect(messages[1]!.content).toContain("Do not create files");
    expect(messages[1]!.content).toContain("<observed-current-turn-evidence>");
    expect(messages[1]!.content).toContain("Never claim a tool action unless");
    expect(messages[1]!.content).toContain("Do not mention the draft");
    expect(messages[1]!.content).toContain("repeat any rejected or unsupported");
    expect(messages[1]!.content).toContain("Do not round values");
    expect(messages[1]!.content).toContain("convert units");
  });
});
