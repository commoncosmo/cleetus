import { describe, expect, it } from "bun:test";
import type { Event } from "../../src/events/types";
import { sumUsage } from "../../src/events/usage";

const evt = (type: Event["type"], payload: unknown): Event => ({
  id: Math.random().toString(36).slice(2),
  sessionId: "s",
  ts: 1,
  type,
  payload,
});

describe("sumUsage", () => {
  it("returns zeros for an empty event list", () => {
    expect(sumUsage([])).toEqual({ input: 0, output: 0 });
  });

  it("sums input and output across model_call_end events", () => {
    expect(
      sumUsage([
        evt("model_call_end", { usage: { input: 100, output: 50 } }),
        evt("model_call_end", { usage: { input: 30, output: 70 } }),
      ]),
    ).toEqual({ input: 130, output: 120 });
  });

  it("ignores other event types", () => {
    expect(
      sumUsage([
        evt("user_input", { text: "hi" }),
        evt("model_call_end", { usage: { input: 5, output: 5 } }),
        evt("assistant_message", { text: "ok" }),
      ]),
    ).toEqual({ input: 5, output: 5 });
  });

  it("treats missing usage fields as zero", () => {
    expect(
      sumUsage([
        evt("model_call_end", {}),
        evt("model_call_end", { usage: {} }),
        evt("model_call_end", { usage: { input: 10 } }),
      ]),
    ).toEqual({ input: 10, output: 0 });
  });
});
