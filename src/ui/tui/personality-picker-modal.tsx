import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { PERSONALITIES, type PersonalityId } from "../../agent/personalities";
import { useTheme } from "../theme";

export interface PersonalityPickerModalProps {
  /** Personality highlighted on open. */
  active?: PersonalityId;
  onSelect: (id: PersonalityId) => void;
  onCancel: () => void;
}

export function PersonalityPickerModal(props: PersonalityPickerModalProps) {
  const t = useTheme();
  const initialIdx = Math.max(
    0,
    PERSONALITIES.findIndex((p) => p.id === props.active),
  );
  const [idx, setIdx] = useState(initialIdx);

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(PERSONALITIES.length - 1, i + 1));
    else if (key.return) {
      const p = PERSONALITIES[idx];
      if (p) props.onSelect(p.id);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>Select a personality (↑/↓ move, enter select, esc cancel):</Text>
      {PERSONALITIES.map((p, i) => {
        const selected = i === idx;
        return (
          <Text key={p.id} color={selected ? t.accent : undefined}>
            {selected ? "› " : "  "}
            {p.id === props.active ? "* " : "  "}
            {p.id}
            <Text color={t.dim}> — {p.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
