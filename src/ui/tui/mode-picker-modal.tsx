import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { MODES, type PermissionMode, modeInfo } from "../../permission/modes";
import { useTheme } from "../theme";

export interface ModePickerModalProps {
  /** Mode highlighted on open. */
  active?: PermissionMode;
  /**
   * When set to a dangerous mode, the modal opens directly on its confirmation
   * screen (used for typed `/mode fuckit`).
   */
  initial?: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
  onCancel: () => void;
}

export function ModePickerModal(props: ModePickerModalProps) {
  const t = useTheme();
  const initialIdx = Math.max(
    0,
    MODES.findIndex((m) => m.id === (props.initial ?? props.active)),
  );
  const [idx, setIdx] = useState(initialIdx);
  // Jump straight to confirmation when opened against a dangerous mode.
  const [confirming, setConfirming] = useState<PermissionMode | null>(
    props.initial && modeInfo(props.initial).dangerous ? props.initial : null,
  );

  useInput((input, key) => {
    if (confirming) {
      if (input === "y" || input === "Y") {
        props.onSelect(confirming);
      } else if (key.escape || input === "n" || input === "N") {
        props.onCancel();
      }
      return;
    }
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(MODES.length - 1, i + 1));
    else if (key.return) {
      const m = MODES[idx];
      if (!m) return;
      if (m.dangerous) setConfirming(m.id);
      else props.onSelect(m.id);
    }
  });

  if (confirming) {
    return (
      <Box flexDirection="column">
        <Text color={t.error}>⚠ Enable {confirming} mode?</Text>
        <Text color={t.dim}>{modeInfo(confirming).description}</Text>
        <Text>y to confirm · n/esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>Select a permission mode (↑/↓ move, enter select, esc cancel):</Text>
      {MODES.map((m, i) => {
        const selected = i === idx;
        return (
          <Text key={m.id} color={selected ? t.accent : undefined}>
            {selected ? "› " : "  "}
            {m.id === props.active ? "* " : "  "}
            <Text color={m.dangerous ? t.error : undefined}>{m.id}</Text>
            <Text color={t.dim}> — {m.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
