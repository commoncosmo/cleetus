import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { PERSONAS, type PersonaId } from "../../agent/personas";
import { useTheme } from "../theme";

export interface PersonaPickerModalProps {
  /** Persona highlighted on open. */
  active?: PersonaId;
  onSelect: (id: PersonaId) => void;
  onCancel: () => void;
}

export function PersonaPickerModal(props: PersonaPickerModalProps) {
  const t = useTheme();
  const initialIdx = Math.max(
    0,
    PERSONAS.findIndex((p) => p.id === props.active),
  );
  const [idx, setIdx] = useState(initialIdx);

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(PERSONAS.length - 1, i + 1));
    else if (key.return) {
      const p = PERSONAS[idx];
      if (p) props.onSelect(p.id);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>Select a persona (↑/↓ move, enter select, esc cancel):</Text>
      {PERSONAS.map((p, i) => {
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
