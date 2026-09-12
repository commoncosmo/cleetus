import { beforeEach, expect, test } from "bun:test";
import type { Event } from "../../src/events/types";
import { segmentTrajectories } from "../../src/insights/trajectory";

let seq = 0;
function ev(type: Event["type"], payload: unknown, ts = ++seq, sessionId = "s1"): Event {
  return { id: `e${seq}`, sessionId, ts, type, payload };
}

beforeEach(() => {
  seq = 0;
});

test("splits a session into one trajectory per user_input", () => {
  const events: Event[] = [
    ev("session_start", {}),
    ev("user_input", { text: "first" }),
    ev("assistant_message", { text: "done 1" }),
    ev("user_input", { text: "second" }),
    ev("assistant_message", { text: "done 2" }),
  ];
  const t = segmentTrajectories(events);
  expect(t).toHaveLength(2);
  expect(t[0]!.userInput).toBe("first");
  expect(t[1]!.userInput).toBe("second");
  expect(t[0]!.outcome).toBe("ok");
});

test("joins tool calls by call.id with duration and ok/error", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("tool_call_start", { call: { id: "c1", name: "bash", args: {} } }, 100),
    ev(
      "tool_call_end",
      { call: { id: "c1", name: "bash", args: {} }, ok: false, errorMessage: "boom" },
      140,
    ),
    ev("assistant_message", { text: "ok" }, 150),
  ];
  const [t] = segmentTrajectories(events);
  expect(t!.toolCalls).toEqual([{ name: "bash", ok: false, errorMessage: "boom", durationMs: 40 }]);
});

test("joins model calls by callId and counts loops excluding finish passes", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("model_call_start", { callId: "m1", model: "x", tier: "small", reason: "speed: gather" }),
    ev("model_call_end", { callId: "m1", reason: "tool-calls", usage: { input: 10, output: 5 } }),
    ev("model_call_start", { callId: "m2", model: "x", tier: "large", reason: "speed: finish" }),
    ev("model_call_end", { callId: "m2", reason: "stop", usage: { input: 3, output: 2 } }),
    ev("assistant_message", { text: "ok" }),
  ];
  const [t] = segmentTrajectories(events);
  expect(t!.loopCount).toBe(1); // finish pass excluded
  expect(t!.modelCalls[0]).toEqual({
    tier: "small",
    reason: "speed: gather",
    finishReason: "tool-calls",
    usage: { input: 10, output: 5 },
    reasoningChars: 0,
  });
  expect(t!.modelCalls[1]!.reason).toBe("speed: finish");
});

test("attaches the terminal reasoning event's text length to its model call by callId", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("model_call_start", { callId: "m1", model: "x", tier: "small", reason: "smart: small" }),
    ev("reasoning", { callId: "m1", text: "let me think about this" }),
    ev("model_call_end", { callId: "m1", reason: "stop", usage: { input: 10, output: 5 } }),
    ev("model_call_start", { callId: "m2", model: "x", tier: "small", reason: "smart: small" }),
    ev("model_call_end", { callId: "m2", reason: "stop" }),
    ev("assistant_message", { text: "ok" }),
  ];
  const [t] = segmentTrajectories(events);
  expect(t!.modelCalls[0]!.reasoningChars).toBe("let me think about this".length);
  expect(t!.modelCalls[1]!.reasoningChars).toBe(0); // no reasoning event for m2
});

test("classifies the turn's task class from its user input", () => {
  const events: Event[] = [
    ev("user_input", { text: "build a web app with a home page" }),
    ev("assistant_message", { text: "ok" }),
    ev("user_input", { text: "what's the weather forecast for tomorrow?" }),
    ev("assistant_message", { text: "ok" }),
    ev("user_input", { text: "thanks!" }),
    ev("assistant_message", { text: "ok" }),
  ];
  const t = segmentTrajectories(events);
  expect(t[0]!.taskClass).toBe("broad_code");
  expect(t[1]!.taskClass).toBe("retrieval");
  expect(t[2]!.taskClass).toBe("conversation");
});

test("pairs permission_request with the following permission_decision", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("permission_request", { tool: "bash", summary: "bash: git status" }),
    ev("permission_decision", { tool: "bash", decision: "allow" }),
    ev("assistant_message", { text: "ok" }),
  ];
  const [t] = segmentTrajectories(events);
  expect(t!.permissions).toEqual([
    { tool: "bash", argsSummary: "bash: git status", decision: "allow" },
  ]);
});

test("classifies error outcome when an error event is present", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("error", { phase: "model", message: "nope" }),
    ev("assistant_message", { text: "" }),
  ];
  expect(segmentTrajectories(events)[0]!.outcome).toBe("error");
});

test("classifies cancelled via the sentinel note", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("assistant_message", { text: "(cancelled)" }),
  ];
  expect(segmentTrajectories(events)[0]!.outcome).toBe("cancelled");
});

test("classifies loop_limit via the stoppedReason marker regardless of text", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("assistant_message", {
      text: "Scaffolded 8 files; reply 'continue' to finish.",
      stoppedReason: "loop_limit",
    }),
  ];
  expect(segmentTrajectories(events)[0]!.outcome).toBe("loop_limit");
});

test("classifies cancelled via the stoppedReason marker", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("assistant_message", { text: "anything", stoppedReason: "cancelled" }),
  ];
  expect(segmentTrajectories(events)[0]!.outcome).toBe("cancelled");
});

test("classifies loop_limit from the legacy sentinel note when no marker is present", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("assistant_message", { text: "(stopped after reaching the tool-call limit)" }),
  ];
  expect(segmentTrajectories(events)[0]!.outcome).toBe("loop_limit");
});

test("marks a turn with no assistant_message and no error as incomplete (outcome ok)", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("tool_call_start", { call: { id: "c1", name: "bash", args: {} } }),
  ];
  const [t] = segmentTrajectories(events);
  expect(t!.incomplete).toBe(true);
  expect(t!.outcome).toBe("ok");
});

test("drops a permission_request that has no following decision", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("permission_request", { tool: "bash", summary: "bash: rm -rf" }),
  ];
  const [t] = segmentTrajectories(events);
  expect(t!.permissions).toEqual([]);
  expect(t!.incomplete).toBe(true);
});

test("does not throw on a null event payload", () => {
  const events: Event[] = [
    ev("user_input", { text: "go" }),
    ev("model_call_start", null),
    ev("assistant_message", { text: "ok" }),
  ];
  expect(() => segmentTrajectories(events)).not.toThrow();
});
