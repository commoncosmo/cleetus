import { Box, Text } from "ink";
import { useTheme } from "../theme";

export function OrchestrationStructuringStatus() {
  const t = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={t.accent}>◆ Structuring orchestration plan…</Text>
      <Text color={t.dim}>No workers have started yet.</Text>
    </Box>
  );
}
