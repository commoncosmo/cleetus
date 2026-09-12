import { describe, expect, it } from "bun:test";
import type { Event } from "../../../src/events/types";
import {
  PALETTE,
  SPINNER_FRAMES,
  THINKING_WORDS,
  TOOL_PHRASES,
  derivePhase,
  pickBusyText,
  pickColor,
  pickFrame,
} from "../../../src/ui/tui/busy";

const evt = (type: Event["type"], payload: unknown): Event => ({
  id: Math.random().toString(36).slice(2),
  sessionId: "s",
  ts: 1,
  type,
  payload,
});

const start = (name: string) => evt("tool_call_start", { call: { name } });
const end = (name: string) => evt("tool_call_end", { call: { name }, ok: true });
const compStart = () => evt("compaction_start", { messageCount: 3, reason: "auto" });
const compEnd = () =>
  evt("compaction_end", { messageCount: 3, elapsedMs: 5, outcome: "summarized" });

describe("derivePhase", () => {
  it("returns thinking for empty events", () => {
    expect(derivePhase([])).toEqual({ kind: "thinking" });
  });

  it("returns thinking when no tool is in flight", () => {
    expect(derivePhase([evt("user_input", { text: "hi" })])).toEqual({ kind: "thinking" });
  });

  it("returns tool when a tool_call_start has no matching end", () => {
    expect(derivePhase([start("bash")])).toEqual({ kind: "tool", tool: "bash" });
  });

  it("returns thinking after the tool finishes", () => {
    expect(derivePhase([start("bash"), end("bash")])).toEqual({ kind: "thinking" });
  });

  it("reflects the latest in-flight tool", () => {
    expect(derivePhase([start("bash"), end("bash"), start("grep")])).toEqual({
      kind: "tool",
      tool: "grep",
    });
  });

  it("returns compaction while a compaction_start has no matching end", () => {
    expect(derivePhase([compStart()])).toEqual({ kind: "compaction" });
  });
  it("clears compaction after compaction_end", () => {
    expect(derivePhase([compStart(), compEnd()])).toEqual({ kind: "thinking" });
  });

  it("shows workflow creator activity and clears it at a review checkpoint", () => {
    const drafting = evt("workflow_status", {
      activity: "creator",
      kind: "workflow_creator_generating",
      workflow: "weather",
      phase: "generating",
    });
    expect(derivePhase([drafting])).toEqual({
      kind: "workflow",
      text: "drafting weather…",
    });
    expect(
      derivePhase([
        drafting,
        evt("workflow_status", {
          activity: "creator",
          kind: "workflow_creator_updated",
          workflow: "weather",
          phase: "questions",
        }),
      ]),
    ).toEqual({ kind: "thinking" });
  });

  it("shows workflow execution step progress and clears on completion", () => {
    const running = evt("workflow_status", {
      workflowEvent: {
        type: "step_status",
        workflow: "weather",
        stepId: "summarize",
        ordinal: 2,
        totalSteps: 3,
        status: "running",
        attempt: 1,
      },
    });
    expect(derivePhase([running])).toEqual({
      kind: "workflow",
      text: "weather · step 2 of 3 · summarize…",
    });
    expect(
      derivePhase([
        running,
        evt("workflow_status", {
          workflowEvent: {
            type: "run_status",
            workflow: "weather",
            status: "succeeded",
          },
        }),
      ]),
    ).toEqual({ kind: "thinking" });
  });
});

describe("pickBusyText", () => {
  it("uses the mapped phrase for a known tool", () => {
    expect(pickBusyText({ kind: "tool", tool: "grep" }, 0)).toBe(TOOL_PHRASES.grep!);
  });

  it("falls back for an unknown tool", () => {
    expect(pickBusyText({ kind: "tool", tool: "frobnicate" }, 0)).toBe("fixin' to frobnicate…");
  });

  it("picks a thinking word by the random value", () => {
    // rand=0 → first word; rand→1 → last word; mid maps via floor(rand * length).
    expect(pickBusyText({ kind: "thinking" }, 0)).toBe(THINKING_WORDS[0]!);
    expect(pickBusyText({ kind: "thinking" }, 0.999999)).toBe(
      THINKING_WORDS[THINKING_WORDS.length - 1]!,
    );
    expect(pickBusyText({ kind: "thinking" }, 0.5)).toBe(
      THINKING_WORDS[Math.floor(0.5 * THINKING_WORDS.length)]!,
    );
  });
});

describe("pickFrame / pickColor", () => {
  it("selects spinner frame by 80ms steps, wrapping", () => {
    expect(pickFrame(0)).toBe(SPINNER_FRAMES[0]!);
    expect(pickFrame(80)).toBe(SPINNER_FRAMES[1]!);
    expect(pickFrame(80 * SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]!);
  });

  it("selects color by 400ms steps, wrapping", () => {
    expect(pickColor(0)).toBe(PALETTE[0]!);
    expect(pickColor(400)).toBe(PALETTE[1]!);
    expect(pickColor(400 * PALETTE.length)).toBe(PALETTE[0]!);
  });
});
