import { expect, test } from "bun:test";
import { stampActor } from "../../src/agent/actor-log";
import type { Event, EventInput, EventSink } from "../../src/events/types";

function fakeSink(): { sink: EventSink; appended: EventInput[] } {
  const appended: EventInput[] = [];
  const sink: EventSink = {
    append(input: EventInput): Event {
      appended.push(input);
      return { ...input, id: "x", ts: 0 };
    },
  };
  return { sink, appended };
}

test("stampActor injects actor into every appended event's payload", () => {
  const { sink, appended } = fakeSink();
  const worker = stampActor(sink, { role: "worker", taskId: "t2" });
  worker.append({ sessionId: "s1", type: "notice", payload: { text: "hi" } });
  expect(appended).toHaveLength(1);
  expect(appended[0]!.payload).toEqual({ text: "hi", actor: { role: "worker", taskId: "t2" } });
  expect(appended[0]!.sessionId).toBe("s1"); // other fields untouched
});

test("stampActor handles object payloads (all cleetus event payloads are objects)", () => {
  const { sink, appended } = fakeSink();
  stampActor(sink, { role: "orchestrator" }).append({
    sessionId: "s",
    type: "model_call_start",
    payload: { callId: "c", model: "m" },
  });
  expect((appended[0]!.payload as { actor: unknown }).actor).toEqual({ role: "orchestrator" });
});

test("stampActor returns the underlying append's Event", () => {
  const { sink } = fakeSink();
  const ev = stampActor(sink, { role: "agent" }).append({
    sessionId: "s",
    type: "notice",
    payload: {},
  });
  expect(ev.id).toBe("x");
});
