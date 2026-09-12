import { expect, test } from "bun:test";
import type { Event } from "../../../src/events/types";
import {
  type BadgeState,
  deriveActorBadges,
  formatActorBadge,
  stepBadge,
} from "../../../src/ui/tui/actor-badges";

let n = 0;
function ev(type: string, payload: Record<string, unknown>): Event {
  n += 1;
  return { id: `e${n}`, sessionId: "s", ts: n, type, payload } as Event;
}

test("first attributable row gets a badge; steady run does not repeat it", () => {
  const events = [
    ev("model_call_start", { model: "qwen-small" }),
    ev("tool_call_start", { call: { id: "1" } }),
    ev("tool_call_start", { call: { id: "2" } }),
  ];
  const badges = deriveActorBadges(events);
  expect(badges.get(events[1]!.id)).toEqual({
    role: "agent",
    model: "qwen-small",
    escalated: false,
  });
  expect(badges.has(events[2]!.id)).toBe(false); // unchanged → no badge
});

test("router escalation (reason 'smart: escalated …', new model) marks escalated", () => {
  const events = [
    ev("model_call_start", { model: "qwen-small", reason: "manual" }),
    ev("tool_call_start", { call: { id: "1" } }),
    ev("model_call_start", {
      model: "qwen-large",
      reason: "smart: escalated (small_reasoned_empty)",
    }),
    ev("tool_call_start", { call: { id: "2" } }),
  ];
  const badges = deriveActorBadges(events);
  expect(badges.get(events[3]!.id)).toEqual({
    role: "agent",
    model: "qwen-large",
    escalated: true,
  });
});

test("a manual model switch (reason 'manual') is a plain badge, not escalated", () => {
  // The router reports why the model changed. A user picking a different model from the model
  // picker produces reason 'manual' — a deliberate switch, not a router escalation — so it must
  // render as an ordinary model badge, never "↑ router →".
  const events = [
    ev("model_call_start", { model: "qwen3.8:27b-mlx", reason: "manual" }),
    ev("assistant_message", { text: "a" }),
    ev("model_call_start", { model: "gpt-oss:20b", reason: "manual" }),
    ev("assistant_message", { text: "b" }),
  ];
  const badges = deriveActorBadges(events);
  expect(badges.get(events[3]!.id)).toEqual({
    role: "agent",
    model: "gpt-oss:20b",
    escalated: false,
  });
});

test("a same-actor model change under a non-escalation reason (e.g. 'speed: finish') is not escalated", () => {
  const events = [
    ev("model_call_start", { model: "small", reason: "speed: gather" }),
    ev("tool_call_start", { call: { id: "1" } }),
    ev("model_call_start", { model: "large", reason: "speed: finish" }),
    ev("tool_call_start", { call: { id: "2" } }),
  ];
  const badges = deriveActorBadges(events);
  expect(badges.get(events[3]!.id)).toEqual({ role: "agent", model: "large", escalated: false });
});

test("actor change (agent→orchestrator→worker) emits badges, not escalated", () => {
  const events = [
    ev("model_call_start", { model: "m1" }),
    ev("assistant_message", { text: "hi" }),
    ev("model_call_start", { model: "m1", actor: { role: "orchestrator" } }),
    ev("notice", { text: "Orchestrating", actor: { role: "orchestrator" } }),
    ev("model_call_start", { model: "m2", actor: { role: "worker", taskId: "t1" } }),
    ev("tool_call_start", { call: { id: "1" }, actor: { role: "worker", taskId: "t1" } }),
  ];
  const badges = deriveActorBadges(events);
  expect(badges.get(events[1]!.id)!.role).toBe("agent");
  expect(badges.get(events[3]!.id)).toEqual({
    role: "orchestrator",
    model: "m1",
    escalated: false,
  });
  expect(badges.get(events[5]!.id)).toEqual({ role: "worker", model: "m2", escalated: false });
});

test("worker→orchestrator hand-back shows the orchestrator's own model, not the worker's", () => {
  // Reproduces the observed mislabel: after a worker runs on the worker model, the
  // orchestrator's "task done" notice must carry the ORCHESTRATOR model — and the
  // orchestrator's next call must NOT look like a spurious escalation.
  const events = [
    ev("model_call_start", { model: "nemotron", actor: { role: "orchestrator" } }),
    ev("notice", { text: "Orchestrating", actor: { role: "orchestrator" } }),
    ev("model_call_start", { model: "north-mini", actor: { role: "worker", taskId: "t1" } }),
    ev("tool_call_start", { call: { id: "1" }, actor: { role: "worker", taskId: "t1" } }),
    ev("notice", { text: "Task 1 done", actor: { role: "orchestrator" } }),
    ev("model_call_start", { model: "nemotron", actor: { role: "orchestrator" } }),
    ev("notice", { text: "next task", actor: { role: "orchestrator" } }),
  ];
  const badges = deriveActorBadges(events);
  // hand-back notice: orchestrator role with the orchestrator model (not the worker's north-mini)
  expect(badges.get(events[4]!.id)).toEqual({
    role: "orchestrator",
    model: "nemotron",
    escalated: false,
  });
  // orchestrator carries on with its own model → no new badge, and no spurious escalation
  expect(badges.has(events[6]!.id)).toBe(false);
});

test("no badge before any model is known", () => {
  const events = [ev("notice", { text: "early" })];
  expect(deriveActorBadges(events).size).toBe(0);
});

test("stepBadge emits a badge on first attributable event, none on an unchanged repeat", () => {
  const start: BadgeState = { lastRole: null, lastModel: null };
  const first = stepBadge(start, ev("tool_call_start", { call: { id: "1" } }), "qwen-small");
  expect(first.badge).toEqual({ role: "agent", model: "qwen-small", escalated: false });
  const second = stepBadge(first.next, ev("tool_call_start", { call: { id: "2" } }), "qwen-small");
  expect(second.badge).toBeUndefined();
});

test("stepBadge marks escalation only when the model-change reason is a router escalation", () => {
  const start: BadgeState = { lastRole: "agent", lastModel: "qwen-small" };
  const manual = stepBadge(start, ev("assistant_message", { text: "hi" }), "qwen-large", "manual");
  expect(manual.badge).toEqual({ role: "agent", model: "qwen-large", escalated: false });
  const escalated = stepBadge(
    start,
    ev("assistant_message", { text: "hi" }),
    "qwen-large",
    "smart: escalated (small_reasoned_empty)",
  );
  expect(escalated.badge).toEqual({ role: "agent", model: "qwen-large", escalated: true });
});

test("stepBadge emits nothing for a non-attributable event or empty model", () => {
  const start: BadgeState = { lastRole: null, lastModel: null };
  expect(stepBadge(start, ev("user_input", { text: "x" }), "qwen-small").badge).toBeUndefined();
  expect(stepBadge(start, ev("tool_call_start", { call: { id: "1" } }), "").badge).toBeUndefined();
});

test("formatActorBadge: a router escalation reads 'router → model'; worker uses ⟐ sigil", () => {
  // "escalated" conflated a router auto-upgrade with a manual switch; the reworded label names the
  // router as the actor that moved the model, and only genuine escalations (escalated:true) get it.
  expect(formatActorBadge({ role: "agent", model: "gpt-oss:20b", escalated: true }).text).toBe(
    "↑ router → gpt-oss:20b",
  );
  expect(formatActorBadge({ role: "agent", model: "gpt-oss:20b", escalated: false }).text).toBe(
    "agent·gpt-oss:20b",
  );
  const w = formatActorBadge({ role: "worker", model: "m", escalated: false });
  expect(w.sigil).toBe("⟐");
  expect(w.worker).toBe(true);
});
