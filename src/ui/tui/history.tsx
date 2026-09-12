import { Box, Static, Text, useStdout } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import { actorOf } from "../../events/types";
import type { TodoItem } from "../../tools/types";
import { DiffView } from "../diff/DiffView";
import { Markdown } from "../markdown/Markdown";
import { parseMarkdown } from "../markdown/parse";
import { sanitizeTerminalText } from "../terminal-text";
import { useTheme } from "../theme";
import { formatActorBadge } from "./actor-badges";
import { diagnosticsRows } from "./diagnostics-rows";
import { FRAME_MS, subscribeFrameClock } from "./frame-clock";
import { formatHandoffLine } from "./handoff-line";
import type { HistoryModel, Row } from "./history-model";
import { spinnerFrame } from "./reasoning-glyph";
import { formatRewindMarker } from "./rewind-marker";
import { proseTail, tailLines } from "./stream-window";
import { type LiveStream, formatThoughtMarker } from "./streaming";
import { TodoView } from "./todo-view";
import { formatToolLine } from "./tool-line";

export interface HistoryProps {
  model: HistoryModel;
  /** Remount key for <Static> so a session swap (/fork, --resume) reprints cleanly. */
  sessionKey: string;
  liveStream?: LiveStream;
  /** When true, render the in-flight model call's prose live (dim + cursor). */
  streamingEnabled?: boolean;
  /** When true, render the reasoning channel live (dim italic). */
  reasoningEnabled?: boolean;
  /** Max visual lines for the live reasoning window (tail-follow); default 10. */
  reasoningLines?: number;
  /** Max visual lines for the live prose window (tail-follow); default 12. */
  proseLines?: number;
}

/** Render a single history row (badge + body). Reused for committed (<Static>) and pending. */
function RowView({ row }: { row: Row }) {
  const t = useTheme();
  const e = row.event;
  const out: React.ReactNode[] = [];

  if (row.spacerBefore) out.push(<Text key={`${e.id}-sp`}> </Text>);

  if (row.badge) {
    const f = formatActorBadge(row.badge);
    out.push(
      <Box key={`${e.id}-badge`}>
        <Text color={f.worker ? t.accentAlt : t.accent}>
          {f.worker ? "  " : ""}
          {f.sigil} {f.text}
        </Text>
      </Box>,
    );
  }

  switch (e.type) {
    case "user_input": {
      const p = e.payload as { text: string; source?: string; title?: string };
      if (p.source) {
        // A down-passed worker/subagent instruction — collapse to a dimmed handoff line so it is
        // unmistakable from a real user prompt; the full text lives in the event log (#152).
        out.push(
          <Box key={e.id}>
            <Text color={t.dim}>
              {"  "}
              {formatHandoffLine(p, actorOf(e))}
            </Text>
          </Box>,
        );
      } else {
        out.push(
          <Box key={e.id}>
            <Text color={t.userInput}>
              {"› "}
              {p.text}
            </Text>
          </Box>,
        );
      }
      break;
    }
    case "workflow_command": {
      const text = sanitizeTerminalText((e.payload as { text: string }).text);
      out.push(
        <Box key={e.id}>
          <Text color={t.userInput}>› {text}</Text>
        </Box>,
      );
      break;
    }
    case "workflow_result": {
      const p = e.payload as {
        text: string;
        format?: "plain" | "markdown";
        workflow?: string;
        status?: string;
        kind?: "message" | "result";
      };
      const text = sanitizeTerminalText(p.text);
      const failed = p.status === "failed" || p.status === "cancelled";
      out.push(
        <Box key={`${e.id}-workflow-heading`}>
          <Text color={failed ? t.error : t.accent}>
            ⚙ {p.workflow ?? "workflow"}
            {p.kind === "result" && p.status ? ` · ${p.status}` : ""}
          </Text>
        </Box>,
      );
      if (text.length > 0) {
        out.push(
          <Box key={e.id} flexDirection="column">
            {p.format === "markdown" ? (
              <Markdown nodes={parseMarkdown(text, t.syntax)} />
            ) : (
              <Text color={failed ? t.error : undefined}>{text}</Text>
            )}
          </Box>,
        );
      }
      break;
    }
    case "assistant_message": {
      const text = (e.payload as { text: string }).text;
      if (text.length > 0) {
        out.push(
          <Box key={e.id} flexDirection="column">
            <Markdown nodes={parseMarkdown(text, t.syntax)} />
          </Box>,
        );
      }
      break;
    }
    case "notice": {
      const p = e.payload as { text: string; level?: "warn" };
      out.push(
        <Box key={e.id}>
          <Text color={p.level === "warn" ? t.warning : t.dim}>
            {p.level === "warn" ? "⚠ " : ""}
            {p.text}
          </Text>
        </Box>,
      );
      break;
    }
    case "turn_reverted": {
      const p = e.payload as {
        userInput: string;
        revertedTurns: number;
        filesRestored: number;
        filesDeleted: number;
        todos?: TodoItem[];
        todosCleared?: boolean;
        filesRestoreSkipped?: boolean;
      };
      out.push(
        <Box key={e.id}>
          <Text color={t.accent}>{formatRewindMarker(p)}</Text>
        </Box>,
      );
      if (p.todos && p.todos.length > 0) {
        out.push(<TodoView key={`${e.id}-todos`} todos={p.todos} />);
      }
      break;
    }
    case "reasoning":
      out.push(
        <Box key={e.id}>
          <Text color={t.dim}>
            {"  "}
            {formatThoughtMarker(row.reasoningMs ?? null)}
          </Text>
        </Box>,
      );
      break;
    case "tool_call_start": {
      const call = (e.payload as { call: { id: string; name: string; args?: unknown } }).call;
      const end = row.end;
      out.push(
        <Box key={e.id}>
          <Text color={end && !end.ok ? t.error : t.toolLine}>
            {"  "}
            {formatToolLine(call, end)}
          </Text>
        </Box>,
      );
      if (end && !end.ok && end.errorMessage) {
        out.push(
          <Box key={`${e.id}-err`}>
            <Text color={t.error}>
              {"    "}
              {end.errorMessage}
            </Text>
          </Box>,
        );
      }
      if (end?.diff) out.push(<DiffView key={`${e.id}-diff`} diff={end.diff} />);
      // The main agent's untitled list is the session working list, which the persistent
      // TodoTracker now owns — printing it here too would be duplicate noise scrolling away.
      // Named lists and worker lists have no tracker and keep their transcript rendering.
      if (end?.todos && (end.todosTitle !== undefined || actorOf(e).role !== "agent")) {
        out.push(<TodoView key={`${e.id}-todos`} todos={end.todos} title={end.todosTitle} />);
      }
      if (end?.diagnostics) {
        out.push(
          <Box key={`${e.id}-diag`} flexDirection="column">
            {diagnosticsRows(end.diagnostics).map((dr, i) => (
              <Text key={`${e.id}-diag-${i}`} color={dr.warn ? t.warning : t.dim}>
                {"    "}
                {dr.text}
              </Text>
            ))}
          </Box>,
        );
      }
      break;
    }
    case "error":
      out.push(
        <Box key={e.id}>
          <Text color={t.error}>[error] {(e.payload as { message: string }).message}</Text>
        </Box>,
      );
      break;
    default:
      break;
  }

  return <>{out}</>;
}

/** Advance a spinner frame counter on the shared frame clock while `active`; frozen (and reset to
 *  0) when inactive so an idle TUI does no timer work. Riding the shared clock rather than a timer
 *  of its own keeps this spin phase-aligned with the busy indicator, so the two never force two
 *  separate frames where one would do. */
function useSpinnerFrame(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      setTick(0);
      return;
    }
    return subscribeFrameClock(FRAME_MS, () => setTick((n) => n + 1));
  }, [active]);
  return tick;
}

export function History({
  model,
  sessionKey,
  liveStream,
  streamingEnabled,
  reasoningEnabled,
  reasoningLines,
  proseLines,
}: HistoryProps) {
  const t = useTheme();
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const reasoningActive = Boolean(
    reasoningEnabled && liveStream && liveStream.reasoning.length > 0,
  );
  const tick = useSpinnerFrame(reasoningActive);
  return (
    <Box flexDirection="column">
      <Static key={sessionKey} items={model.committed}>
        {(row) => <RowView key={row.event.id} row={row} />}
      </Static>
      <Box flexDirection="column">
        {model.pending.map((row) => (
          <RowView key={row.event.id} row={row} />
        ))}
        {reasoningEnabled && liveStream && liveStream.reasoning.length > 0 && (
          <Box flexDirection="column">
            <Text color={t.dim}>{`${spinnerFrame(tick)} thinking…`}</Text>
            {(reasoningLines ?? 10) > 0 &&
              tailLines(liveStream.reasoning, Math.max(1, width - 2), reasoningLines ?? 10).map(
                (line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a transient, fully-recomputed tail with no element identity to keep
                  <Text key={i} color={t.dim} italic>{`  ${line}`}</Text>
                ),
              )}
          </Box>
        )}
        {streamingEnabled &&
          liveStream &&
          liveStream.prose.length > 0 &&
          (proseLines ?? 12) > 0 && (
            <Box flexDirection="column">
              {proseTail(liveStream.prose, Math.max(1, width - 1), proseLines ?? 12).map(
                (line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a transient, fully-recomputed tail with no element identity to keep
                  <Text key={i} color={t.dim}>
                    {line}
                  </Text>
                ),
              )}
            </Box>
          )}
      </Box>
    </Box>
  );
}
