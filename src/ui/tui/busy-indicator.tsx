import { Text } from "ink";
import { useMemo, useRef } from "react";
import type { Event } from "../../events/types";
import { useTheme } from "../theme";
import { SPINNER_MS, WORD_MS, derivePhase, pickBusyText, pickColor, pickFrame } from "./busy";
import { useTick } from "./use-tick";

export interface BusyIndicatorProps {
  /** Session events, used to decide what the agent is currently doing. */
  events: Event[];
}

/** Animated, color-cycling, phase-aware busy line shown while a turn runs. */
export function BusyIndicator({ events }: BusyIndicatorProps) {
  const t = useTheme();
  // Reset on every mount — elapsed is relative to this turn's visible start.
  const startRef = useRef(Date.now());
  useTick(SPINNER_MS);

  // Recompute the phase only when events change, not on every animation tick.
  const phase = useMemo(() => derivePhase(events), [events]);

  const elapsed = Date.now() - startRef.current;
  const frame = pickFrame(elapsed);
  const color = pickColor(elapsed);
  const seconds = Math.floor(elapsed / 1000);

  // Roll a fresh random word once per WORD_MS window and hold it steady between
  // animation frames, so the phrase changes on its own beat rather than flickering
  // every tick. Reset when not thinking so returning to a thinking phase re-rolls.
  const wordTick = Math.floor(elapsed / WORD_MS);
  const wordRef = useRef({ tick: -1, text: "" });
  if (phase.kind === "thinking") {
    if (wordRef.current.tick !== wordTick) {
      wordRef.current = { tick: wordTick, text: pickBusyText(phase) };
    }
  } else {
    wordRef.current = { tick: -1, text: "" };
  }
  const text =
    phase.kind === "tool" || phase.kind === "workflow"
      ? pickBusyText(phase)
      : phase.kind === "compaction"
        ? "compacting context…"
        : wordRef.current.text;

  return (
    <Text>
      {/* Spinner cycles a fixed animation palette (pickColor) — intentionally not themed. */}
      <Text color={color}>{frame}</Text>
      <Text color={t.dim}>
        {" "}
        {text} ({seconds}s · esc to cancel)
      </Text>
    </Text>
  );
}
