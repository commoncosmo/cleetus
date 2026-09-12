import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { EFFORTS, type EffortLevel } from "../../agent/effort";
import { useTheme } from "../theme";

export interface EffortPickerModalProps {
  /** Level highlighted on open. */
  active?: EffortLevel;
  onSelect: (level: EffortLevel) => void;
  onCancel: () => void;
}

export function EffortPickerModal(props: EffortPickerModalProps) {
  const t = useTheme();
  const initialIdx = Math.max(
    0,
    EFFORTS.findIndex((e) => e.id === props.active),
  );
  const [idx, setIdx] = useState(initialIdx);

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(EFFORTS.length - 1, i + 1));
    else if (key.return) {
      const e = EFFORTS[idx];
      if (e) props.onSelect(e.id);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>Select reasoning effort (↑/↓ move, enter select, esc cancel):</Text>
      {EFFORTS.map((e, i) => {
        const selected = i === idx;
        return (
          <Text key={e.id} color={selected ? t.accent : undefined}>
            {selected ? "› " : "  "}
            {e.id === props.active ? "* " : "  "}
            {e.id}
            <Text color={t.dim}> — {e.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
