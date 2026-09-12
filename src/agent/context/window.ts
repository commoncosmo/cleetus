import type { Message } from "../../providers/types";
import { estimateTokens } from "./budget";

/** Rough token cost of one message: content plus any tool-call names/args. */
export function messageTokens(m: Message): number {
  let t = estimateTokens(m.content);
  for (const c of m.toolCalls ?? [])
    t += estimateTokens(c.name) + estimateTokens(JSON.stringify(c.args));
  return t;
}

/** Sum messageTokens over history[from, to). */
export function sumTokens(history: Message[], from: number, to: number): number {
  let t = 0;
  for (let i = from; i < to; i++) t += messageTokens(history[i]!);
  return t;
}

/** Index of the live turn's first message — the slice from the last user message to the
 *  end. This slice is never trimmed. Returns 0 when there is no user message. */
export function liveTurnStart(history: Message[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user" && history[i]!.turnOrigin) return i;
  }
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "user") return i;
  }
  return 0;
}

/**
 * Compute the index at which the sent tail should begin so that the tail history[boundary,
 * end) costs at most `recentTokens`. Backfills newest-first from the TRUE end of history, so
 * the boundary may land anywhere — including inside the current live turn when that turn
 * alone is large. The newest message is always kept (the tail is never empty), even if it
 * alone exceeds `recentTokens`. Never starts the tail on an orphaned `tool` result (whose
 * assistant tool-call parent would be evicted — OpenAI-compatible providers reject a leading
 * tool message). Returns 0 when everything fits. Pure.
 */
export function computeRecentBoundary(history: Message[], recentTokens: number): number {
  let total = 0;
  let boundary = history.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = messageTokens(history[i]!);
    // Always keep the newest message (boundary still === history.length); after that, stop
    // once adding another message would exceed the recent-token reserve.
    if (boundary < history.length && total + t > recentTokens) break;
    total += t;
    boundary = i;
  }
  while (boundary < history.length && history[boundary]!.role === "tool") boundary++;
  return boundary;
}

/**
 * Clamp a fold boundary so the most-recent tool-result group is never summarized away. Finds
 * the last `tool` message, walks back over its contiguous sibling results to the assistant
 * tool-call message that issued them, and returns min(boundary, parentIndex) so that parent and
 * its results stay in the verbatim tail. Returns `boundary` unchanged when there is no tool
 * result or the boundary is already at/before the parent. Pure.
 */
export function protectFreshestToolResult(history: Message[], boundary: number): number {
  let lastTool = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === "tool") {
      lastTool = i;
      break;
    }
  }
  if (lastTool < 0) return boundary;
  // Walk back over the contiguous tool-result group to the assistant parent just before it.
  let parent = lastTool;
  while (parent > 0 && history[parent - 1]!.role === "tool") parent--;
  parent--; // step onto the assistant tool-call message that issued the group
  if (parent < 0) return boundary;
  return Math.min(boundary, parent);
}
