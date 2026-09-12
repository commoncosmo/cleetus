import { Box, Text } from "ink";
import { todoGlyph } from "../../tools/todo-core";
import type { TodoItem } from "../../tools/types";
import { useTheme } from "../theme";
import { trackerRow, trackerWindow } from "./todo-meter";
import { useTick } from "./use-tick";

/** Empty meter cells and the `^t` hint sit one step below `theme.dim`, a rank the Theme has no
 *  role for. Per the handoff: prefer `blackBright` over growing the Theme for a single value. */
const DIMMER = "blackBright";

/** Repaint cadence for the elapsed clock. Only ever runs while a turn is in flight. */
const CLOCK_MS = 1000;

export interface TodoTrackerProps {
  todos: TodoItem[];
  /** `^t` unfolds the header into the full checklist; the header itself is unchanged. */
  expanded: boolean;
  /** `Date.now()` when the current in_progress item became current; null when there is none. */
  startedAt: number | null;
  /** `Date.now()` at the list's first in_progress transition — the all-done total counts from here. */
  listStartedAt: number | null;
  /** `Date.now()` when the list went all-complete, freezing the total. Null while unfinished. */
  finishedAt: number | null;
  /** True while a turn is in flight: the clock ticks, and a stopped list reads `paused` instead. */
  busy: boolean;
  /** Row budget for the expanded body, markers included. The header is not counted. */
  maxRows: number;
}

/**
 * The persistent todo tracker: a one-row progress meter mounted below the transcript, unfolding
 * on `^t` into the full checklist. The header row is byte-identical in both states — only the
 * right-aligned hint changes — so `^t` reads as unfolding rather than as swapping in a different
 * widget, and the current task never leaves the screen.
 *
 * Must be mounted OUTSIDE `<Static>`: inside it, the widget would render once and silently never
 * repaint.
 */
export function TodoTracker({
  todos,
  expanded,
  startedAt,
  listStartedAt,
  finishedAt,
  busy,
  maxRows,
}: TodoTrackerProps) {
  const t = useTheme();
  // Only a running clock needs a repaint cadence; a paused or finished list is already frozen.
  useTick(CLOCK_MS, busy && startedAt !== null && finishedAt === null);

  if (todos.length === 0) return null;

  const now = Date.now();
  const { meter, text, complete } = trackerRow({
    todos,
    busy,
    currentElapsedMs: startedAt !== null ? now - startedAt : null,
    listElapsedMs: listStartedAt !== null ? (finishedAt ?? now) - listStartedAt : null,
  });

  // Complete: the whole row goes green and the hint is dropped — there is nothing left to unfold.
  const hint = complete ? null : expanded ? "^t collapse" : "^t";

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text>
          {" "}
          <Text color={complete ? t.success : t.accent}>{meter.filled}</Text>
          <Text color={complete ? t.success : DIMMER}>{meter.empty}</Text>
          <Text color={complete ? t.success : t.dim}> {text}</Text>
        </Text>
        {hint ? <Text color={DIMMER}>{hint} </Text> : null}
      </Box>
      {expanded && !complete ? <TrackerBody todos={todos} maxRows={maxRows} /> : null}
    </Box>
  );
}

/** The unfolded checklist, windowed to the row budget and capped with `↑ N done` / `↓ N to go` —
 *  deliberately the same vocabulary `Input` uses for its suggestion list. */
function TrackerBody({ todos, maxRows }: { todos: TodoItem[]; maxRows: number }) {
  const t = useTheme();
  const { above, items, below } = trackerWindow(todos, maxRows);
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column">
      {above > 0 ? <Text color={t.dim}> ↑ {above} done</Text> : null}
      {items.map((item, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: todo rows are positional, not identities
          key={i}
          color={
            item.status === "completed"
              ? t.dim
              : item.status === "in_progress"
                ? t.accent
                : undefined
          }
        >
          {" "}
          {todoGlyph(item.status)} {item.content}
        </Text>
      ))}
      {below > 0 ? <Text color={t.dim}> ↓ {below} to go</Text> : null}
    </Box>
  );
}
