/**
 * Stable glyphs for reasoning. The turn-level busy indicator owns the only animation; keeping
 * this marker still prevents two competing motion sources while the model is thinking.
 */

/** Hollow dot shown while the reasoning panel is live. Single-width and static. */
export const THINKING_LIVE_GLYPH = "◌";

/** Solid dot shown on the committed marker once thinking is complete. */
export const THINKING_DONE_GLYPH = "●";
