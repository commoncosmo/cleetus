import { expect, test } from "bun:test";
import { DEFAULT_PLAN_MODE_GUARD, resolvePlanModeGuard } from "../../src/config/plan-mode";
import { PlanModeObjectSchema } from "../../src/config/schema";

test("defaults when nothing configured", () => {
  expect(resolvePlanModeGuard(undefined, undefined)).toEqual(DEFAULT_PLAN_MODE_GUARD);
  expect(DEFAULT_PLAN_MODE_GUARD.forcePlanAfterBlocks).toBe(3);
});

test("project overrides global overrides default", () => {
  const r = resolvePlanModeGuard({ force_plan_after_blocks: 5 }, { force_plan_after_blocks: 2 });
  expect(r.forcePlanAfterBlocks).toBe(2); // project (2nd arg) wins
});

test("global-only value is used", () => {
  expect(resolvePlanModeGuard({ force_plan_after_blocks: 7 }, undefined).forcePlanAfterBlocks).toBe(
    7,
  );
});

test("schema accepts 0 (disabled) and rejects negatives", () => {
  expect(PlanModeObjectSchema.safeParse({ force_plan_after_blocks: 0 }).success).toBe(true);
  expect(PlanModeObjectSchema.safeParse({ force_plan_after_blocks: -1 }).success).toBe(false);
});
