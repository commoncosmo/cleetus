import { expect, test } from "bun:test";
import { evaluatePermission } from "../../src/permission/evaluator";
import type { Message } from "../../src/providers/types";
import { InvestigationNotesTool, investigationNotes } from "../../src/tools/investigation-notes";

test("notes reject oversized evidence and respect explicit permission denies", async () => {
  const tool = new InvestigationNotesTool();
  expect(
    (await tool.run({ findings: [{ summary: "x".repeat(301), evidence: "file.ts:1" }] })).ok,
  ).toBe(false);
  expect(evaluatePermission({ project: [], global: [] }, tool.name, "notes")).toBe("allow");
  expect(
    evaluatePermission(
      { project: [{ tool: tool.name, decision: "deny" }], global: [] },
      tool.name,
      "notes",
    ),
  ).toBe("deny");
});

test("only a matched successful notebook call can supply retained evidence", async () => {
  const tool = new InvestigationNotesTool();
  const valid = await tool.run({
    findings: [{ summary: "Verified budget cap", evidence: "budget.ts:48" }],
  });
  const history: Message[] = [{ role: "tool", toolCallId: "read", content: valid.output! }];
  expect(investigationNotes(history)).toBe("");
  history.unshift({
    role: "assistant",
    content: "",
    toolCalls: [{ id: "notes", name: tool.name, args: {} }],
  });
  history.push({ role: "tool", toolCallId: "notes", content: valid.output! });
  history.push({
    role: "assistant",
    content: "",
    toolCalls: [{ id: "bad", name: tool.name, args: {} }],
  });
  history.push({ role: "tool", toolCallId: "bad", content: "error: invalid notebook" });
  expect(investigationNotes(history)).toBe(valid.output!);
});
