import { expect, test } from "bun:test";
import type { Event } from "../../../src/events/types";
import { deriveActorBadges } from "../../../src/ui/tui/actor-badges";
import {
  type HistoryModel,
  advanceHistory,
  emptyHistoryModel,
  seedHistory,
  settlePending,
} from "../../../src/ui/tui/history-model";
import { reasoningDurationMs } from "../../../src/ui/tui/streaming";

let n = 0;
function ev(type: string, payload: Record<string, unknown>): Event {
  n += 1;
  return { id: `e${n}`, sessionId: "s", ts: n, type, payload } as Event;
}
function fold(events: Event[], reasoning = true): HistoryModel {
  let m = emptyHistoryModel(reasoning);
  for (const e of events) m = advanceHistory(m, e);
  return m;
}
const ids = (rows: { event: Event }[]) => rows.map((r) => r.event.id);

test("a completed assistant_message settles straight to committed, never parked full-height in pending", () => {
  // Root cause of the duplicate-final-answer bug: a finished answer left in the dynamic (pending)
  // region renders full-height and, on a short terminal, trips Ink's clearTerminal reprint — then
  // it settles into <Static> a render later, appearing twice in scrollback. The answer must reach
  // committed (<Static>) in the same step it arrives, since it takes no further updates.
  const msg = ev("assistant_message", { text: "the answer" });
  const m = fold([ev("model_call_start", { model: "q", callId: "c1" }), msg]);
  expect(ids(m.committed)).toEqual([msg.id]);
  expect(m.pending).toEqual([]);
});

test("an assistant_message does not jump ahead of an in-flight tool row (order preserved)", () => {
  // Safety guard: the immediate-commit path only triggers when nothing in-flight precedes the
  // answer. A tool still awaiting its end must keep the answer parked so committed order stays
  // chronological (the tool settles first, then the answer, once the tool completes).
  const tool = ev("tool_call_start", { call: { id: "1", name: "bash" } });
  const msg = ev("assistant_message", { text: "x" });
  const m = fold([ev("model_call_start", { model: "q", callId: "c1" }), tool, msg]);
  expect(ids(m.committed)).toEqual([]);
  expect(ids(m.pending)).toEqual([tool.id, msg.id]);
});

test("a tool_call_start stays pending until its end, then settles on the next row event", () => {
  const start = ev("tool_call_start", { call: { id: "1", name: "bash" } });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), start]);
  expect(ids(m.committed)).toEqual([]);
  expect(ids(m.pending)).toEqual([start.id]);
  m = advanceHistory(m, ev("tool_call_end", { call: { id: "1" }, ok: true }));
  expect(ids(m.committed)).toEqual([]);
  expect(m.pending[0]!.end?.ok).toBe(true);
  // The tool is final now, so the arriving assistant_message settles it AND (nothing in-flight
  // remaining) commits itself in the same step — the dynamic region is left empty.
  const msg = ev("assistant_message", { text: "done" });
  m = advanceHistory(m, msg);
  expect(ids(m.committed)).toEqual([start.id, msg.id]);
  expect(m.pending).toEqual([]);
});

test("per-step diagnostics attaches to the tool row before it settles", () => {
  const start = ev("tool_call_start", { call: { id: "1", name: "edit_file" } });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), start]);
  m = advanceHistory(m, ev("tool_call_end", { call: { id: "1" }, ok: true }));
  m = advanceHistory(m, ev("diagnostics", { callId: "1", text: "tsc: 1 error" }));
  expect(m.pending[0]!.end?.diagnostics).toBe("tsc: 1 error");
  m = advanceHistory(m, ev("tool_call_start", { call: { id: "2", name: "bash" } }));
  expect(m.committed[0]!.end?.diagnostics).toBe("tsc: 1 error");
});

test("already-committed Row objects keep referential identity as new events arrive", () => {
  const a = ev("assistant_message", { text: "a" });
  const b = ev("assistant_message", { text: "b" });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), a, b]);
  const committedA = m.committed[0];
  expect(ids(m.committed)).toEqual([a.id, b.id]);
  m = advanceHistory(m, ev("notice", { text: "x" }));
  m = advanceHistory(m, ev("assistant_message", { text: "c" }));
  expect(m.committed[0]).toBe(committedA);
});

test("badge attribution matches deriveActorBadges over the same sequence", () => {
  const events = [
    ev("model_call_start", { model: "qwen-small", callId: "c1" }),
    ev("tool_call_start", { call: { id: "1", name: "bash" } }),
    ev("model_call_start", { model: "qwen-large", callId: "c2" }),
    ev("assistant_message", { text: "hi" }),
    ev("user_input", { text: "next" }),
  ];
  const m = fold(events);
  const expected = deriveActorBadges(events);
  for (const r of [...m.committed, ...m.pending]) {
    expect(r.badge).toEqual(expected.get(r.event.id));
  }
});

test("a manual mid-conversation model switch does not badge the next row as escalated", () => {
  // Real report: routing on manual, user switches models via the picker; the next turn's row was
  // mislabeled "escalated". The badge must reflect the router's reason ('manual'), not merely that
  // the model changed.
  const events = [
    ev("model_call_start", { model: "qwen3.8:27b-mlx", callId: "c1", reason: "manual" }),
    ev("assistant_message", { text: "first" }),
    ev("user_input", { text: "Try again with a new list" }),
    ev("model_call_start", { model: "gpt-oss:20b", callId: "c2", reason: "manual" }),
    ev("reasoning", { callId: "c2", text: "thinking" }),
    ev("assistant_message", { text: "second" }),
  ];
  const m = fold(events);
  const rows = [...m.committed, ...m.pending];
  const escalatedBadges = rows.filter((r) => r.badge?.escalated);
  expect(escalatedBadges).toEqual([]);
  // The gpt-oss turn still carries a plain model badge so the model change stays visible.
  const gptBadge = rows.find((r) => r.badge?.model === "gpt-oss:20b")?.badge;
  expect(gptBadge).toEqual({ role: "agent", model: "gpt-oss:20b", escalated: false });
});

test("reasoning row carries the same duration as reasoningDurationMs", () => {
  const startCall = ev("model_call_start", { model: "q", callId: "c1" });
  const reason = ev("reasoning", { callId: "c1" });
  const m = fold([startCall, reason]);
  const row = [...m.committed, ...m.pending].find((r) => r.event.id === reason.id)!;
  expect(row.reasoningMs).toBe(reasoningDurationMs([startCall, reason], "c1"));
  expect(row.reasoningMs).toBe(reason.ts - startCall.ts);
});

test("reasoning rows are omitted when reasoning is disabled", () => {
  const events = [
    ev("model_call_start", { model: "q", callId: "c1" }),
    ev("reasoning", { callId: "c1" }),
  ];
  const m = fold(events, false);
  expect([...m.committed, ...m.pending].some((r) => r.event.type === "reasoning")).toBe(false);
});

test("internal protocol assistant messages remain out of the rendered transcript", () => {
  const protocol = ev("assistant_message", {
    text: '{"verdict":"fail"}',
    internalProtocol: true,
    actor: { role: "worker", taskId: "integration-verify" },
  });
  const m = fold([protocol]);
  expect(ids([...m.committed, ...m.pending])).toEqual([]);
});

test("verbose-only notices stay durable but are hidden from the normal transcript", () => {
  const diagnostic = ev("notice", {
    text: "discarded internal correction",
    visibility: "verbose",
  });
  const normal = fold([diagnostic]);
  const verbose = seedHistory([diagnostic], true, true);
  expect(ids([...normal.committed, ...normal.pending])).toEqual([]);
  expect(ids([...verbose.committed, ...verbose.pending])).toEqual([diagnostic.id]);
});

test("warning notices are hidden normally and rendered in verbose mode", () => {
  const warning = ev("notice", {
    text: "bounded finish pass reached its output ceiling",
    level: "warn",
  });
  const normal = fold([warning]);
  const verbose = seedHistory([warning], true, true);
  expect(ids([...normal.committed, ...normal.pending])).toEqual([]);
  expect(ids([...verbose.committed, ...verbose.pending])).toEqual([warning.id]);
});

test("warning-like payloads on non-notice events remain visible", () => {
  const result = ev("assistant_message", {
    text: "The task stopped before completion.",
    level: "warn",
  });
  const normal = fold([result]);
  expect(ids([...normal.committed, ...normal.pending])).toEqual([result.id]);
});

test("parallel tool calls in one step settle together and in order", () => {
  const a = ev("tool_call_start", { call: { id: "1", name: "bash" } });
  const b = ev("tool_call_start", { call: { id: "2", name: "bash" } });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), a, b]);
  m = advanceHistory(m, ev("tool_call_end", { call: { id: "1" }, ok: true }));
  m = advanceHistory(
    m,
    ev("tool_call_end", { call: { id: "2" }, ok: false, errorMessage: "boom" }),
  );
  expect(ids(m.committed)).toEqual([]);
  // The arriving answer settles both finished tools (in order) and commits itself in the same step.
  const done = ev("assistant_message", { text: "done" });
  m = advanceHistory(m, done);
  expect(ids(m.committed)).toEqual([a.id, b.id, done.id]);
  expect(m.committed[1]!.end?.errorMessage).toBe("boom");
});

test("the first user_input has no spacer; later ones do", () => {
  const u1 = ev("user_input", { text: "one" });
  const u2 = ev("user_input", { text: "two" });
  const m = fold([u1, u2]);
  const r1 = [...m.committed, ...m.pending].find((r) => r.event.id === u1.id)!;
  const r2 = [...m.committed, ...m.pending].find((r) => r.event.id === u2.id)!;
  expect(r1.spacerBefore).toBeFalsy();
  expect(r2.spacerBefore).toBe(true);
});

test("workflow commands and results remain in the durable transcript", () => {
  const command = ev("workflow_command", { text: "/workflow run weather" });
  const result = ev("workflow_result", {
    text: "- Mild tomorrow",
    format: "markdown",
    workflow: "weather",
    status: "succeeded",
  });
  const next = ev("workflow_command", { text: "/workflow history weather" });
  const m = fold([command, result, next]);
  const rows = [...m.committed, ...m.pending];
  expect(ids(rows)).toEqual([command.id, result.id, next.id]);
  expect(rows.find((row) => row.event.id === command.id)!.spacerBefore).toBeFalsy();
  expect(rows.find((row) => row.event.id === next.id)!.spacerBefore).toBe(true);
});

test("seedHistory equals folding events one at a time", () => {
  const events = [
    ev("user_input", { text: "go" }),
    ev("model_call_start", { model: "q", callId: "c1" }),
    ev("tool_call_start", { call: { id: "1", name: "bash" } }),
    ev("tool_call_end", { call: { id: "1" }, ok: true }),
    ev("assistant_message", { text: "done" }),
  ];
  const seeded = seedHistory(events, true);
  const folded = fold(events);
  expect(ids(seeded.committed)).toEqual(ids(folded.committed));
  expect(ids(seeded.pending)).toEqual(ids(folded.pending));
});

test("a worker user_input is not a real user turn: no spacer, seenUser untouched", () => {
  const realUser = ev("user_input", { text: "build me an app" });
  const workerInput = ev("user_input", {
    text: "do task A",
    source: "orchestration-worker",
    title: "Task A",
    actor: { role: "worker", taskId: "t1" },
  });
  const nextRealUser = ev("user_input", { text: "now add tests" });
  const m = fold([realUser, workerInput, nextRealUser]);
  const byId = new Map(m.committed.concat(m.pending).map((r) => [r.event.id, r]));
  // worker handoff gets no spacer
  expect(byId.get(workerInput.id)!.spacerBefore).toBeFalsy();
  // the worker turn did NOT count as "a user turn", but the FIRST real user did,
  // so the second real user still gets its spacer.
  expect(byId.get(nextRealUser.id)!.spacerBefore).toBe(true);
});

test("a worker user_input before any real user input does not set seenUser", () => {
  const workerInput = ev("user_input", {
    text: "do task A",
    actor: { role: "worker", taskId: "t1" },
  });
  const realUser = ev("user_input", { text: "hello" });
  const m = fold([workerInput, realUser]);
  const byId = new Map(m.committed.concat(m.pending).map((r) => [r.event.id, r]));
  expect(byId.get(workerInput.id)!.spacerBefore).toBeFalsy();
  // first real user turn: still no spacer (seenUser was never set by the worker)
  expect(byId.get(realUser.id)!.spacerBefore).toBeFalsy();
});

test("model_call_start eager-settles a finished tool row into committed", () => {
  const start = ev("tool_call_start", { call: { id: "1", name: "edit_file" } });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), start]);
  m = advanceHistory(m, ev("tool_call_end", { call: { id: "1" }, ok: true }));
  m = advanceHistory(m, ev("diagnostics", { callId: "1", text: "tsc: ok" }));
  // still pending after end+diagnostics (no row-producing / step-boundary event yet)
  expect(ids(m.pending)).toEqual([start.id]);
  // the NEXT step's model_call_start settles it — with its end + diagnostics intact
  m = advanceHistory(m, ev("model_call_start", { model: "q", callId: "c2" }));
  expect(ids(m.committed)).toEqual([start.id]);
  expect(ids(m.pending)).toEqual([]);
  expect(m.committed[0]!.end?.ok).toBe(true);
  expect(m.committed[0]!.end?.diagnostics).toBe("tsc: ok");
});

test("model_call_start does NOT settle a still-running tool row (no end yet)", () => {
  const start = ev("tool_call_start", { call: { id: "1", name: "bash" } });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), start]);
  // a second model_call_start arrives before this tool's end (parallel/streaming shape)
  m = advanceHistory(m, ev("model_call_start", { model: "q", callId: "c2" }));
  expect(ids(m.committed)).toEqual([]);
  expect(ids(m.pending)).toEqual([start.id]);
});

test("the first model_call_start of a turn commits the user_input echo row", () => {
  const u = ev("user_input", { text: "go" });
  let m = fold([u]);
  expect(ids(m.pending)).toEqual([u.id]);
  m = advanceHistory(m, ev("model_call_start", { model: "q", callId: "c1" }));
  expect(ids(m.committed)).toEqual([u.id]);
  expect(ids(m.pending)).toEqual([]);
});

test("model_call_start with no callId/model still eager-settles finished rows", () => {
  const start = ev("tool_call_start", { call: { id: "1", name: "bash" } });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), start]);
  m = advanceHistory(m, ev("tool_call_end", { call: { id: "1" }, ok: true }));
  m = advanceHistory(m, ev("model_call_start", {})); // bare step boundary
  expect(ids(m.committed)).toEqual([start.id]);
});

test("settlePending commits a finished tool row left in the dynamic region at idle", () => {
  // Answers now settle on arrival, but a turn that ends on a completed tool (no following
  // assistant_message to trigger the next-event settle) leaves that finished tool row parked in
  // `pending`. Rendered full-height there, it trips Ink's clearTerminal branch on a short terminal
  // and visibly duplicates. Idle-time settlePending moves it into <Static> so the dynamic region
  // holds only in-flight rows.
  const u = ev("user_input", { text: "hi" });
  const start = ev("tool_call_start", { call: { id: "1", name: "bash" } });
  let m = fold([u, ev("model_call_start", { model: "q", callId: "c1" }), start]);
  m = advanceHistory(m, ev("tool_call_end", { call: { id: "1" }, ok: true }));
  expect(ids(m.pending)).toEqual([start.id]); // the finished tool lingers in the dynamic region

  const settled = settlePending(m);
  expect(ids(settled.pending)).toEqual([]);
  expect(ids(settled.committed)).toEqual([u.id, start.id]);
});

test("settlePending keeps an in-flight tool row pending (no reorder) and is a no-op ref", () => {
  const start = ev("tool_call_start", { call: { id: "1", name: "bash" } });
  const m = fold([ev("model_call_start", { model: "q", callId: "c1" }), start]);
  const settled = settlePending(m);
  expect(ids(settled.pending)).toEqual([start.id]);
  expect(settled).toBe(m); // nothing final to settle → same reference, no needless re-render
});

test("settlePending returns the same model when nothing is pending", () => {
  const m = emptyHistoryModel(true);
  expect(settlePending(m)).toBe(m);
});

test("settlePending preserves already-committed Row identity (append-only <Static>)", () => {
  const a = ev("assistant_message", { text: "a" });
  const later = ev("assistant_message", { text: "later" });
  let m = fold([ev("model_call_start", { model: "q", callId: "c1" }), a, later]);
  const committedA = m.committed[0];
  m = settlePending(m);
  expect(m.committed[0]).toBe(committedA); // same object → Ink never re-renders it
  expect(ids(m.pending)).toEqual([]);
});
