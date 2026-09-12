export interface HistoryState {
  /** Current input buffer. */
  value: string;
  /** Index into history while recalling, or null when editing a fresh line. */
  histIdx: number | null;
  /** The in-progress line saved when recall began, restored when walking past the newest entry. */
  draft: string;
}

export type VerticalNavigationTarget = "suggestions" | "cursor" | "history";

/**
 * Decide what Up/Down should control. A recalled history entry keeps ownership
 * of the arrows even when its text would normally open autocomplete (notably a
 * bare slash command) or contains newlines. Editing the recalled entry clears
 * `recalling`, returning the arrows to autocomplete/the cursor.
 */
export function verticalNavigationTarget(opts: {
  suggestionCount: number;
  multiline: boolean;
  recalling: boolean;
}): VerticalNavigationTarget {
  if (opts.recalling) return "history";
  if (opts.suggestionCount > 0) return "suggestions";
  return opts.multiline ? "cursor" : "history";
}

/** Walk one step back (older) through prompt history — bound to the Up arrow. */
export function historyPrev(state: HistoryState, history: string[]): HistoryState {
  if (history.length === 0) return state;
  if (state.histIdx === null) {
    const idx = history.length - 1;
    return { value: history[idx]!, histIdx: idx, draft: state.value };
  }
  if (state.histIdx > 0) {
    const idx = state.histIdx - 1;
    return { value: history[idx]!, histIdx: idx, draft: state.draft };
  }
  return state; // already at the oldest entry
}

/** Walk one step forward (newer) through prompt history — bound to the Down arrow. */
export function historyNext(state: HistoryState, history: string[]): HistoryState {
  if (state.histIdx === null) return state;
  if (state.histIdx < history.length - 1) {
    const idx = state.histIdx + 1;
    return { value: history[idx]!, histIdx: idx, draft: state.draft };
  }
  // past the newest entry — restore the saved draft
  return { value: state.draft, histIdx: null, draft: state.draft };
}
