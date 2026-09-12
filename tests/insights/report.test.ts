import { beforeEach, expect, test } from "bun:test";
import type { EventSource } from "../../src/events/log";
import type { Event } from "../../src/events/types";
import { analyze, collectTrajectories } from "../../src/insights/report";

function makeSource(bySession: Record<string, Event[]>): EventSource {
  return {
    listSessions: () => Object.keys(bySession),
    query: (id) => bySession[id] ?? [],
  };
}
let seq = 0;
function ev(sessionId: string, type: Event["type"], payload: unknown, ts = ++seq): Event {
  return { id: `e${seq}`, sessionId, ts, type, payload };
}

beforeEach(() => {
  seq = 0;
});

test("assembles a report across multiple sessions", () => {
  const source = makeSource({
    s1: [
      ev("s1", "user_input", { text: "a" }, 10),
      ev("s1", "assistant_message", { text: "ok" }, 11),
    ],
    s2: [
      ev("s2", "user_input", { text: "b" }, 20),
      ev("s2", "assistant_message", { text: "ok" }, 21),
    ],
  });
  const r = analyze(source, {});
  expect(r.sessionCount).toBe(2);
  expect(r.trajectoryCount).toBe(2);
  expect(r.turnEfficiency.outcomes.ok).toBe(2);
});

test("since filter drops older trajectories", () => {
  const source = makeSource({
    s1: [
      ev("s1", "user_input", { text: "old" }, 100),
      ev("s1", "assistant_message", { text: "ok" }, 101),
      ev("s1", "user_input", { text: "new" }, 500),
      ev("s1", "assistant_message", { text: "ok" }, 501),
    ],
  });
  const t = collectTrajectories(source, { since: 300 });
  expect(t).toHaveLength(1);
  expect(t[0]!.userInput).toBe("new");
});

test("session filter restricts to one session", () => {
  const source = makeSource({
    s1: [
      ev("s1", "user_input", { text: "a" }, 10),
      ev("s1", "assistant_message", { text: "ok" }, 11),
    ],
    s2: [
      ev("s2", "user_input", { text: "b" }, 20),
      ev("s2", "assistant_message", { text: "ok" }, 21),
    ],
  });
  const r = analyze(source, { sessionId: "s2" });
  expect(r.trajectoryCount).toBe(1);
  expect(r.sessionCount).toBe(1);
});

test("includes the reasoning-cost breakdown keyed by the turn's task class", () => {
  const source = makeSource({
    s1: [
      ev("s1", "user_input", { text: "build a web app with a home page" }, 10),
      ev("s1", "model_call_start", { callId: "m1", tier: "small", reason: "smart: small" }, 11),
      ev("s1", "reasoning", { callId: "m1", text: "x".repeat(400) }, 12),
      ev("s1", "model_call_end", { callId: "m1", reason: "stop", usage: { output: 200 } }, 13),
      ev("s1", "assistant_message", { text: "ok" }, 14),
    ],
  });
  const r = analyze(source, {});
  expect(r.reasoningCost.hasReasoning).toBe(true);
  expect(r.reasoningCost.byTaskClass.broad_code.calls).toBe(1);
  expect(r.reasoningCost.byTaskClass.broad_code.estReasoningTokens).toBe(100);
  expect(r.reasoningCost.byTaskClass.conversation.calls).toBe(0);
});

test("empty source yields a zeroed report", () => {
  const r = analyze(makeSource({}), {});
  expect(r.sessionCount).toBe(0);
  expect(r.trajectoryCount).toBe(0);
  expect(r.toolReliability.tools).toEqual([]);
  expect(r.routingCost.totalTokens).toBeNull();
});
