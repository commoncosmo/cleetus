import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { ROUTE_MODES, type RouteMode } from "../../agent/route-modes";
import { useTheme } from "../theme";

export interface RoutePickerModalProps {
  /** Mode highlighted on open. */
  active?: RouteMode;
  /** Tiers are required for speed/smart; when absent those rows are shown disabled. */
  tiersConfigured: boolean;
  onSelect: (mode: RouteMode) => void;
  onCancel: () => void;
}

export function RoutePickerModal(props: RoutePickerModalProps) {
  const t = useTheme();
  const initialIdx = Math.max(
    0,
    ROUTE_MODES.findIndex((m) => m.id === props.active),
  );
  const [idx, setIdx] = useState(initialIdx);

  const disabled = (id: RouteMode) => !props.tiersConfigured && (id === "speed" || id === "smart");

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(ROUTE_MODES.length - 1, i + 1));
    else if (key.return) {
      const m = ROUTE_MODES[idx];
      if (!m || disabled(m.id)) return;
      props.onSelect(m.id);
    }
  });

  return (
    <Box flexDirection="column">
      <Text>Select a routing mode (↑/↓ move, enter select, esc cancel):</Text>
      {ROUTE_MODES.map((m, i) => {
        const selected = i === idx;
        const off = disabled(m.id);
        return (
          <Text key={m.id} color={selected ? t.accent : undefined}>
            {selected ? "› " : "  "}
            {m.id === props.active ? "* " : "  "}
            <Text color={off ? t.dim : undefined}>{m.id}</Text>
            <Text color={t.dim}>
              {" "}
              — {m.description}
              {off ? " (needs tiers)" : ""}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}
