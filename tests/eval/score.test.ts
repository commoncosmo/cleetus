import { expect, test } from "bun:test";
import { scoreRun } from "../../src/eval/score";
import type { RunRecord } from "../../src/eval/types";
import type { Event } from "../../src/events/types";

let seq = 0;
function ev(type: Event["type"], payload: unknown): Event {
  seq++;
  return { id: `e${seq}`, sessionId: "run", ts: seq, type, payload };
}

function record(over: Partial<RunRecord>): RunRecord {
  seq = 0;
  const events: Event[] = [
    ev("user_input", { text: "do it" }),
    ev("model_call_start", { callId: "m1", model: "x", tier: "small", reason: "smart: small" }),
    ev("tool_call_start", { call: { id: "c1", name: "bash", args: {} } }),
    ev("tool_call_end", {
      call: { id: "c1", name: "bash", args: {} },
      ok: false,
      errorMessage: "boom",
    }),
    ev("model_call_end", { callId: "m1", reason: "stop", usage: { input: 10, output: 4 } }),
    ev("assistant_message", { text: "done" }),
  ];
  return {
    candidate: "baseline",
    scenario: "s",
    events,
    checkExitCode: 0,
    agentOutcome: "completed",
    elapsedMs: 123,
    ...over,
  };
}

test("passed requires completed agent AND check exit 0; scalars come from 5A", () => {
  const s = scoreRun(record({}));
  expect(s.passed).toBe(true);
  expect(s.toolFailures).toBe(1);
  expect(s.loops).toBe(1);
  expect(s.tokens).toBe(14);
  expect(s.elapsedMs).toBe(123);
  expect(s.metrics.trajectoryCount).toBe(1);
});

test("failed check → not passed", () => {
  expect(scoreRun(record({ checkExitCode: 1 })).passed).toBe(false);
});

test("non-completed agent → not passed even if check passed", () => {
  expect(scoreRun(record({ agentOutcome: "timed_out", checkExitCode: 0 })).passed).toBe(false);
});

test("null tokens → 0", () => {
  const events: Event[] = [
    { id: "e1", sessionId: "run", ts: 1, type: "user_input", payload: { text: "hi" } },
    { id: "e2", sessionId: "run", ts: 2, type: "assistant_message", payload: { text: "ok" } },
  ];
  const s = scoreRun({
    candidate: "b",
    scenario: "s",
    events,
    checkExitCode: 0,
    agentOutcome: "completed",
    elapsedMs: 1,
  });
  expect(s.tokens).toBe(0);
  expect(s.toolFailures).toBe(0);
});
