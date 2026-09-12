import { expect, test } from "bun:test";
import { originalUserRequests } from "../../src/agent/acceptance";
import { liveTurnStart } from "../../src/agent/context/window";
import { selectedPlanStep } from "../../src/agent/plan-mode";

test("keeps original spec corrections, excluding generated execution and audit instructions", () => {
  const requests = originalUserRequests([
    { role: "user", content: "unrelated old task" },
    { role: "user", content: "/spec Build an Ollama chat app" },
    {
      role: "user",
      content:
        "Collapse thinking when answer content starts.\n<system-reminder>injected skill</system-reminder>",
    },
    { role: "assistant", content: "Spec: expand when finished" },
    { role: "user", content: "Implement step 4 of 5: expand when finished" },
    { role: "user", content: "<system-reminder>Audit the spec</system-reminder>" },
  ]);
  expect(requests).toContain("Collapse thinking when answer content starts");
  expect(requests).not.toContain("expand when finished");
  expect(requests).not.toContain("unrelated");
  expect(requests).not.toContain("injected skill");
});

test("selected step retains shared constraints, its files and checks, but omits later implementation", () => {
  const plan =
    "Shared constraint: preserve persisted conversations.\n## Step 1 — Shell\nEdit App.tsx.\n## Step 2 — Stream\nEdit client.ts. Verify partial chunks.\n## Step 3 — Memory\nEdit storage.ts.";
  const packet = selectedPlanStep(plan, ["— Shell", "— Stream", "— Memory"], 1);
  expect(packet).toContain("preserve persisted conversations");
  expect(packet).toContain("Edit client.ts. Verify partial chunks");
  expect(packet).not.toContain("Edit App.tsx");
  expect(packet).not.toContain("Edit storage.ts");
});

test("synthetic audit reminders cannot replace the active originating request during trimming", () => {
  expect(
    liveTurnStart([
      { role: "user", content: "Fix invisible controls", turnOrigin: true },
      { role: "assistant", content: "working" },
      { role: "user", content: "<system-reminder>Audit now</system-reminder>" },
    ]),
  ).toBe(0);
});

test("explicit user provenance preserves imperative requests and excludes wrapped host turns", () => {
  const result = originalUserRequests([
    { role: "user", content: "/spec build chat", userRequest: "/spec build chat" },
    {
      role: "user",
      content: "generated revision wrapper",
      userRequest: "Keep thinking expanded until answer text arrives",
    },
    {
      role: "user",
      content: "Implement the approved spec, but preserve session history",
      userRequest: "Implement the approved spec, but preserve session history",
    },
    { role: "user", content: "generated plan with conflicting requirements", userRequest: null },
  ]);
  expect(result).toContain("preserve session history");
  expect(result).toContain("Keep thinking expanded until answer text arrives");
  expect(result).not.toContain("generated");
});
