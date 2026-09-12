import type { Message } from "../../providers/types";

/** Truncate a tool message to ~`cap` chars, keeping the head and the tail with the marker
 *  in between. Tail-weighted (25/75): compilers and test runners put the failure summary at
 *  the END of output, so the tail is what the model needs to recover (mirrors bash.ts's
 *  truncate). Returns the message unchanged (by reference) when already within the cap.
 *  Never mutates the input. */
function capToolResult(m: Message, cap: number, marker: (removed: number) => string): Message {
  if (m.content.length <= cap) return m;
  const removed = m.content.length - cap;
  const headLen = Math.floor(cap * 0.25);
  const tailLen = cap - headLen;
  return {
    ...m,
    content: `${m.content.slice(0, headLen)}\n${marker(removed)}\n${m.content.slice(m.content.length - tailLen)}`,
  };
}

/**
 * Return copies of `tail` (the sent window, a slice of history starting at global index
 * `boundaryIndex`) with oversized `tool` results truncated. Two-tier: results BEFORE the live
 * turn are capped at `deepCap`; results AT/AFTER the live turn (`globalIndex >= liveStart`) are
 * capped at the larger `liveCap` so one fresh result can't dominate the sent input. `liveStart`
 * is the GLOBAL index of the live turn's first message; a tail element's global index is
 * `boundaryIndex + i`. Non-tool and short messages are returned unchanged (by reference).
 * Deterministic; never mutates the input. Pure.
 */
export function slimDeepHistory(
  tail: Message[],
  liveStart: number,
  boundaryIndex: number,
  deepCap: number,
  liveCap: number,
): Message[] {
  return tail.map((m, i) => {
    if (m.role !== "tool") return m;
    const globalIndex = boundaryIndex + i;
    if (globalIndex >= liveStart) {
      return capToolResult(
        m,
        liveCap,
        (removed) =>
          `… [truncated ${removed} chars — request a narrower range or re-fetch a specific section]`,
      );
    }
    return capToolResult(
      m,
      deepCap,
      (removed) => `… [truncated ${removed} chars — older tool output]`,
    );
  });
}
