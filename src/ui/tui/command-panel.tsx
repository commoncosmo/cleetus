import { Box, Text } from "ink";
import { useTheme } from "../theme";

export interface CommandPanelProps {
  /** Latest command output; null/empty renders nothing. */
  text: string | null;
}

/** Ephemeral bordered panel for slash-command output, shown above the input. */
export function CommandPanel({ text }: CommandPanelProps) {
  const t = useTheme();
  if (!text) return null;
  return (
    <Box borderStyle="round" borderColor={t.dim} flexDirection="column" paddingX={1}>
      {text.split("\n").map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: panel lines are positional
        <Text key={i} color={t.dim}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
