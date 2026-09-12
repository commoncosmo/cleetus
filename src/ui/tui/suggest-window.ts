/** Max suggestion rows visible at once before windowing kicks in. */
export const SUGGEST_PAGE = 10;

export interface SuggestWindow {
  /** Index of the first visible row. */
  offset: number;
  /** Count hidden above the window (0 → no "↑ N more"). */
  aboveCount: number;
  /** Count hidden below the window (0 → no "↓ N more"). */
  belowCount: number;
}

/**
 * Centered window over a list of `total` items with the given `selected` index.
 * Keeps the selection centered while clamping so the window never runs past
 * either end. When `total <= page`, offset is 0 and nothing is hidden.
 */
export function suggestWindow(total: number, selected: number, page = SUGGEST_PAGE): SuggestWindow {
  if (total <= page) return { offset: 0, aboveCount: 0, belowCount: 0 };
  const offset = Math.max(0, Math.min(selected - Math.floor(page / 2), total - page));
  return { offset, aboveCount: offset, belowCount: total - offset - page };
}
