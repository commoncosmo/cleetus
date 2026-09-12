import { expect, test } from "bun:test";
import { REVIEWER_PREAMBLE, buildReviewerPrompt } from "../../src/agent/review";

test("REVIEWER_PREAMBLE frames an adversarial, verify-capable reviewer", () => {
  const p = REVIEWER_PREAMBLE.toLowerCase();
  // attacks rather than summarizes
  expect(p).toContain("do not summarize");
  // verifies by execution, scoped
  expect(p).toContain("run_tests");
  expect(p).toContain("confirm a specific");
  // checks scope adherence
  expect(p).toContain("scope");
  // emits the structured-lite template
  expect(REVIEWER_PREAMBLE).toContain("[Critical]");
  expect(REVIEWER_PREAMBLE).toContain("verified:");
});

test("buildReviewerPrompt embeds the diff, file list, and intent", () => {
  const prompt = buildReviewerPrompt({
    subject: {
      diff: "diff --git a/x.ts b/x.ts\n+bad",
      files: ["x.ts"],
      label: "working-tree diff",
    },
    intent: "add empty-input handling",
  });
  expect(prompt).toContain("working-tree diff");
  expect(prompt).toContain("diff --git a/x.ts");
  expect(prompt).toContain("x.ts");
  expect(prompt).toContain("add empty-input handling");
});

test("buildReviewerPrompt omits the intent section when intent is absent", () => {
  const prompt = buildReviewerPrompt({
    subject: { diff: "d", files: ["x.ts"], label: "working-tree diff" },
  });
  expect(prompt.toLowerCase()).not.toContain("original request");
});

test("buildReviewerPrompt: codebase subject drops the diff block and gives a survey directive", () => {
  const prompt = buildReviewerPrompt({
    subject: { kind: "codebase", diff: "", files: [], label: "the entire codebase" },
  });
  expect(prompt).not.toContain("```diff");
  expect(prompt.toLowerCase()).toContain("survey");
  expect(prompt).toContain("read_file");
});

test("buildReviewerPrompt: codebase subject still honors the intent trailer", () => {
  const prompt = buildReviewerPrompt({
    subject: { kind: "codebase", diff: "", files: [], label: "the entire codebase" },
    intent: "make it faster",
  });
  expect(prompt).toContain("ORIGINAL REQUEST");
  expect(prompt).toContain("make it faster");
});

test("buildReviewerPrompt: a diff subject still embeds the diff block", () => {
  const prompt = buildReviewerPrompt({
    subject: {
      kind: "diff",
      diff: "diff --git a/x b/x\n+1",
      files: ["x"],
      label: "working-tree diff",
    },
  });
  expect(prompt).toContain("```diff");
  expect(prompt).toContain("Files touched: x");
});
