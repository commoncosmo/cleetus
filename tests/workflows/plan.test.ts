import { expect, it } from "bun:test";
import type { WorkflowExecutionPlan } from "../../src/workflows/plan";

it("keeps normalized plan types serially ordered", () => {
  const plan = {
    steps: [{ ordinal: 0 }, { ordinal: 1 }],
  } as WorkflowExecutionPlan;
  expect(plan.steps.map((step) => step.ordinal)).toEqual([0, 1]);
});
