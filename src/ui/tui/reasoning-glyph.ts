/**
 * Glyphs for the live reasoning indicator. While the model is thinking, the live header cycles
 * through a quadrant spinner; once the reasoning block commits, the marker shows a solid static
 * dot. All frames are single-width so the indicator never shifts the layout (unlike the wide 💭
 * emoji it replaces — see issue #132).
 */

/** Quadrant spinner frames cycled in the live "thinking…" header. Single-width. */
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

/** Solid dot shown on the committed marker once thinking is complete. */
export const THINKING_DONE_GLYPH = "●";

/** The spinner frame for a given tick, wrapping around (and tolerant of negative ticks). Pure. */
export function spinnerFrame(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((tick % n) + n) % n] as string;
}
