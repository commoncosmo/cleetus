import { expect, test } from "bun:test";
import { stickyReminders } from "../../src/agent/sticky-reminders";

const TDD = "<tdd>";
const SEC = "<sec>";

test("entering plan mode drops the previous arc, then accumulates this turn", () => {
  const r = stickyReminders([TDD], true, false, [SEC]);
  expect(r.arc).toEqual([TDD]);
  expect(r.inject).toEqual([TDD]);
});

test("accumulates across plan-mode turns (a non-triggering amend keeps the skill)", () => {
  const r = stickyReminders([], true, true, [TDD]);
  expect(r.arc).toEqual([TDD]);
  expect(r.inject).toEqual([TDD]);
});

test("replays the frozen arc after plan mode exits (the ct14 case)", () => {
  const r = stickyReminders([], false, true, [TDD]);
  expect(r.arc).toEqual([TDD]); // frozen — unchanged outside plan mode
  expect(r.inject).toEqual([TDD]);
});

test("persists through consecutive implementation follow-ups", () => {
  const r1 = stickyReminders([], false, false, [TDD]);
  expect(r1.inject).toEqual([TDD]);
  const r2 = stickyReminders([], false, false, r1.arc);
  expect(r2.inject).toEqual([TDD]);
});

test("a fresh plan supersedes the prior arc", () => {
  const r = stickyReminders([SEC], true, false, [TDD]);
  expect(r.arc).toEqual([SEC]);
  expect(r.inject).toEqual([SEC]);
});

test("dedupes a skill present in both current and arc", () => {
  const r = stickyReminders([TDD], false, false, [TDD]);
  expect(r.inject).toEqual([TDD]);
});

test("plan-less path injects exactly current and never fills the arc", () => {
  const r = stickyReminders([TDD], false, false, []);
  expect(r.arc).toEqual([]);
  expect(r.inject).toEqual([TDD]);
});
