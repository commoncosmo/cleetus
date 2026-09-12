import type { Event } from "../../events/types";
import { THINKING_DONE_GLYPH } from "./reasoning-glyph";

/** The live streaming overlay for the in-flight model call: accumulated reasoning and prose
 *  text, keyed by call id. Updated incrementally by `reduceLive` so the TUI never rescans the
 *  full event history per chunk. */
export interface LiveStream {
  callId: string | null;
  reasoning: string;
  prose: string;
}

/** True for the two high-frequency streaming event types that must NOT enter the React events
 *  array (they produce no history rows and would cause an O(n) rescan per chunk). */
export function isStreamChunk(type: Event["type"]): boolean {
  return type === "reasoning_chunk" || type === "model_call_chunk";
}

/**
 * Fold one event into the live streaming buffer. Mirrors the commit semantics of the former
 * deriveStreamingProse/deriveStreamingReasoning, but incrementally (O(1) per event):
 *  - model_call_start  → reset to the new call (empty reasoning + prose)
 *  - reasoning_chunk    → append to reasoning (matching callId only)
 *  - model_call_chunk   → append to prose (matching callId only)
 *  - reasoning (terminal)→ clear reasoning (the committed marker now renders from events)
 *  - assistant_message  → clear prose AND reasoning (commit/cancel hands off to the row;
 *                          covers a cancelled runaway that emits no terminal `reasoning`)
 *  - anything else      → unchanged (model_call_end does NOT clear prose — the one-frame
 *                          window between end and assistant_message stays visible)
 * Pure; returns the same object reference when nothing changes.
 */
export function reduceLive(prev: LiveStream, e: Event): LiveStream {
  switch (e.type) {
    case "model_call_start": {
      const callId = (e.payload as { callId?: string }).callId ?? null;
      return { callId, reasoning: "", prose: "" };
    }
    case "reasoning_chunk": {
      const p = e.payload as { callId: string; text: string };
      if (p.callId !== prev.callId) return prev;
      return { ...prev, reasoning: prev.reasoning + p.text };
    }
    case "model_call_chunk": {
      const p = e.payload as { callId: string; text: string };
      if (p.callId !== prev.callId) return prev;
      return { ...prev, prose: prev.prose + p.text };
    }
    case "reasoning": {
      const p = e.payload as { callId?: string };
      if (p.callId !== prev.callId) return prev;
      return { ...prev, reasoning: "" };
    }
    case "assistant_message":
      // Commit clears both overlays: prose hands off to the message row, and any lingering
      // reasoning is dropped too — a cancelled runaway emits this without a terminal `reasoning`
      // event, so without this the 💭 overlay would persist until the next model_call_start.
      return prev.prose || prev.reasoning ? { ...prev, prose: "", reasoning: "" } : prev;
    default:
      return prev;
  }
}

/** One-line collapsed marker for a committed reasoning block. */
export function formatThoughtMarker(durationMs: number | null): string {
  if (durationMs === null) return `${THINKING_DONE_GLYPH} thought`;
  return `${THINKING_DONE_GLYPH} thought for ${Math.round(durationMs / 1000)}s`;
}

/**
 * Wall-clock ms from a call's `model_call_start` to its terminal `reasoning` event.
 * Null when the start can't be found (so the marker renders without a duration).
 */
export function reasoningDurationMs(events: Event[], callId: string): number | null {
  let startTs: number | null = null;
  for (const e of events) {
    if (e.type === "model_call_start" && (e.payload as { callId?: string }).callId === callId) {
      startTs = e.ts;
    } else if (e.type === "reasoning" && (e.payload as { callId?: string }).callId === callId) {
      return startTs === null ? null : e.ts - startTs;
    }
  }
  return null;
}
