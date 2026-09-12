import { expect, it, test } from "bun:test";
import { DEFAULT_LOOP_GUARD, resolveLoopGuard } from "../../src/config/loop-guard";

test("defaults: enabled with sane thresholds", () => {
  expect(DEFAULT_LOOP_GUARD).toEqual({
    enabled: true,
    editRepeatThreshold: 5,
    failRepeatThreshold: 3,
    windowSize: 12,
    cooldown: 6,
    noProgressThreshold: 4,
    escapeThreshold: 2,
    blockThreshold: 2,
    hiddenRepeatThreshold: 3,
    cmdFailAbort: 6,
  });
});

test("default no_progress_threshold is 4", () => {
  expect(DEFAULT_LOOP_GUARD.noProgressThreshold).toBe(4);
  expect(resolveLoopGuard().noProgressThreshold).toBe(4);
});

test("no_progress_threshold resolves project > global > default", () => {
  expect(
    resolveLoopGuard({ no_progress_threshold: 8 }, { no_progress_threshold: 3 })
      .noProgressThreshold,
  ).toBe(3);
  expect(resolveLoopGuard({ no_progress_threshold: 8 }, undefined).noProgressThreshold).toBe(8);
});

test("project overrides global", () => {
  const c = resolveLoopGuard({ enabled: false, edit_repeat_threshold: 4 }, { window_size: 20 });
  expect(c.enabled).toBe(false); // global (project undefined)
  expect(c.editRepeatThreshold).toBe(4); // global
  expect(c.windowSize).toBe(20); // project
  expect(c.failRepeatThreshold).toBe(3); // default
});

it("resolves escape_threshold with project over global over default", () => {
  expect(resolveLoopGuard({ escape_threshold: 4 }, { escape_threshold: 3 }).escapeThreshold).toBe(
    3,
  );
  expect(resolveLoopGuard().escapeThreshold).toBe(2);
});

test("block_threshold: default 2, project > global precedence, 0 survives", () => {
  expect(resolveLoopGuard(undefined, undefined).blockThreshold).toBe(2);
  expect(DEFAULT_LOOP_GUARD.blockThreshold).toBe(2);
  expect(resolveLoopGuard({ block_threshold: 5 }, undefined).blockThreshold).toBe(5);
  expect(resolveLoopGuard({ block_threshold: 5 }, { block_threshold: 3 }).blockThreshold).toBe(3);
  expect(resolveLoopGuard(undefined, { block_threshold: 0 }).blockThreshold).toBe(0);
});

test("hidden_repeat_threshold defaults to 3 and resolves project > global", () => {
  expect(resolveLoopGuard(undefined, undefined).hiddenRepeatThreshold).toBe(3);
  expect(resolveLoopGuard({ hidden_repeat_threshold: 5 }, undefined).hiddenRepeatThreshold).toBe(5);
  expect(
    resolveLoopGuard({ hidden_repeat_threshold: 5 }, { hidden_repeat_threshold: 2 })
      .hiddenRepeatThreshold,
  ).toBe(2);
});

it("resolves cmd_fail_abort with project over global over default, allowing 0", () => {
  expect(resolveLoopGuard({ cmd_fail_abort: 10 }, { cmd_fail_abort: 0 }).cmdFailAbort).toBe(0);
  expect(resolveLoopGuard({ cmd_fail_abort: 10 }, undefined).cmdFailAbort).toBe(10);
  expect(resolveLoopGuard().cmdFailAbort).toBe(6);
});
