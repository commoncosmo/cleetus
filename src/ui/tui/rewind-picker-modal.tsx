import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../theme";
import { type RewindCheckpoint, rewindRows } from "./rewind-row";
import { listWindow, modalBudget } from "./stream-window";
import { useTerminalRows } from "./use-terminal-rows";

export interface RewindPickerModalProps {
  checkpoints: RewindCheckpoint[];
  onSelect: (turnNumber: number) => void;
  onCancel: () => void;
}

export function RewindPickerModal(props: RewindPickerModalProps) {
  const t = useTheme();
  const rows = rewindRows(props.checkpoints, Date.now());
  const [idx, setIdx] = useState(0);
  // A long turn history would otherwise render every checkpoint and push the dynamic region past
  // the viewport, which puts Ink into its full-screen-clear branch on every frame.
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
      if (row) props.onSelect(row.turnNumber);
    }
  });

  if (rows.length === 0) {
    return <Text color={t.dim}>nothing to rewind to (esc to close)</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>Rewind to checkpoint (↑/↓ move, enter revert, esc cancel):</Text>
      {view.above > 0 && <Text color={t.dim}>{`  ↑ ${view.above} more`}</Text>}
      {view.items.map((row, i) => {
        const selected = i === view.selected;
        return (
          <Text key={row.turnNumber} color={selected ? t.accent : undefined}>
            {selected ? "› " : "  "}
            {row.turnNumber}
            {"  "}
            {row.label}
            <Text color={t.dim}>
              {"  "}
              {row.age}
            </Text>
          </Text>
        );
      })}
      {view.below > 0 && <Text color={t.dim}>{`  ↓ ${view.below} more`}</Text>}
    </Box>
  );
}
