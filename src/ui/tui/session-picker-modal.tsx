import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../theme";
import type { SessionRow } from "./session-row";
import { listWindow, modalBudget } from "./stream-window";
import { useTerminalRows } from "./use-terminal-rows";

export interface SessionPickerModalProps {
  rows: SessionRow[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}

export function SessionPickerModal(props: SessionPickerModalProps) {
  const t = useTheme();
  const { rows } = props;
  const [idx, setIdx] = useState(0);
  // A long history would otherwise render every row and push the dynamic region past the
  // viewport, which puts Ink into its full-screen-clear branch on every frame.
  const termRows = useTerminalRows();
  const view = listWindow(rows, idx, modalBudget(termRows));

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(rows.length - 1, i + 1));
    else if (key.return) {
      const row = rows[idx];
      if (row) props.onSelect(row.id);
    }
  });

  if (rows.length === 0) {
    return <Text color={t.dim}>no resumable sessions (esc to close)</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>Resume session (↑/↓ move, enter resume, esc cancel):</Text>
      {view.above > 0 && <Text color={t.dim}>{`  ↑ ${view.above} more`}</Text>}
      {view.items.map((row, i) => (
        <Text key={row.id} color={i === view.selected ? t.accent : undefined}>
          {i === view.selected ? "› " : "  "}
          {row.label}
        </Text>
      ))}
      {view.below > 0 && <Text color={t.dim}>{`  ↓ ${view.below} more`}</Text>}
    </Box>
  );
}
