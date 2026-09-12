import { describe, expect, it } from "bun:test";
import type { Event } from "../../../src/events/types";
import {
  type LiveStream,
  formatThoughtMarker,
  isStreamChunk,
  reasoningDurationMs,
  reduceLive,
} from "../../../src/ui/tui/streaming";

let seq = 0;
const ev = (type: Event["type"], payload: unknown): Event => ({
  id: `e${seq++}`,
  ts: seq,
  sessionId: "s",
  type,
  payload,
});

describe("formatThoughtMarker", () => {
  it("formats a duration in whole seconds", () => {
    expect(formatThoughtMarker(12000)).toBe("● thought for 12s");
  });
  it("rounds sub-second durations", () => {
    expect(formatThoughtMarker(400)).toBe("● thought for 0s");
  });
  it("drops the duration when null", () => {
    expect(formatThoughtMarker(null)).toBe("● thought");
  });
});

describe("reasoningDurationMs", () => {
  it("returns reasoning.ts minus model_call_start.ts for the callId", () => {
    const events: Event[] = [
      { id: "a", ts: 100, sessionId: "s", type: "model_call_start", payload: { callId: "K" } },
      { id: "b", ts: 140, sessionId: "s", type: "reasoning", payload: { callId: "K", text: "x" } },
    ];
    expect(reasoningDurationMs(events, "K")).toBe(40);
  });

  it("returns null when the model_call_start for the callId is absent", () => {
    const events: Event[] = [
      { id: "b", ts: 140, sessionId: "s", type: "reasoning", payload: { callId: "K", text: "x" } },
    ];
    expect(reasoningDurationMs(events, "K")).toBeNull();
  });
});

describe("reduceLive", () => {
  const empty: LiveStream = { callId: null, reasoning: "", prose: "" };

  it("accumulates reasoning + prose for the in-flight call", () => {
    let s = reduceLive(empty, ev("model_call_start", { callId: "K" }));
    s = reduceLive(s, ev("reasoning_chunk", { callId: "K", text: "think " }));
    s = reduceLive(s, ev("reasoning_chunk", { callId: "K", text: "more" }));
    s = reduceLive(s, ev("model_call_chunk", { callId: "K", text: "answer" }));
    expect(s).toEqual({ callId: "K", reasoning: "think more", prose: "answer" });
  });

  it("ignores chunks whose callId does not match the current call", () => {
    let s = reduceLive(empty, ev("model_call_start", { callId: "K" }));
    s = reduceLive(s, ev("reasoning_chunk", { callId: "OTHER", text: "x" }));
    s = reduceLive(s, ev("model_call_chunk", { callId: "OTHER", text: "y" }));
    expect(s).toEqual({ callId: "K", reasoning: "", prose: "" });
  });

  it("clears reasoning when the terminal reasoning event commits", () => {
    let s = reduceLive(empty, ev("model_call_start", { callId: "K" }));
    s = reduceLive(s, ev("reasoning_chunk", { callId: "K", text: "t" }));
    s = reduceLive(s, ev("reasoning", { callId: "K", text: "t" }));
    expect(s.reasoning).toBe("");
  });

  it("keeps prose through model_call_end (one-frame window) and clears it on assistant_message", () => {
    let s = reduceLive(empty, ev("model_call_start", { callId: "K" }));
    s = reduceLive(s, ev("model_call_chunk", { callId: "K", text: "ans" }));
    s = reduceLive(s, ev("model_call_end", { callId: "K" }));
    expect(s.prose).toBe("ans");
    s = reduceLive(s, ev("assistant_message", { text: "ans" }));
    expect(s.prose).toBe("");
  });

  it("clears a lingering reasoning overlay on assistant_message (ESC-cancel of a reasoning-only runaway)", () => {
    // A cancelled runaway never emits the terminal `reasoning` event (that fires only on
    // finish), so reasoning would otherwise linger; the `(cancelled)` assistant_message clears it.
    let s = reduceLive(empty, ev("model_call_start", { callId: "K" }));
    s = reduceLive(s, ev("reasoning_chunk", { callId: "K", text: "thinking forever" }));
    s = reduceLive(s, ev("assistant_message", { text: "(cancelled)" }));
    expect(s.reasoning).toBe("");
    expect(s.prose).toBe("");
  });

  it("a new model_call_start resets both buffers to the new call", () => {
    let s: LiveStream = { callId: "K", reasoning: "old", prose: "old" };
    s = reduceLive(s, ev("model_call_start", { callId: "L" }));
    expect(s).toEqual({ callId: "L", reasoning: "", prose: "" });
  });

  it("leaves the buffer unchanged for unrelated events", () => {
    const s: LiveStream = { callId: "K", reasoning: "r", prose: "p" };
    expect(reduceLive(s, ev("tool_call_start", { call: { id: "x" } }))).toBe(s);
  });
});

describe("isStreamChunk", () => {
  it("is true only for the two high-frequency chunk types", () => {
    expect(isStreamChunk("reasoning_chunk")).toBe(true);
    expect(isStreamChunk("model_call_chunk")).toBe(true);
    expect(isStreamChunk("model_call_start")).toBe(false);
    expect(isStreamChunk("assistant_message")).toBe(false);
  });
});
