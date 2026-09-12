import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme";

export interface SpecRevisionPromptProps {
  specPath: string;
  onBack: () => void;
}

/** Shown after `r` on the draft picker. The text input stays live underneath — the next submitted
 * line is the revision sent to the model. Only `esc` is handled here (back to the draft picker);
 * every other key belongs to the input. */
export function SpecRevisionPrompt(props: SpecRevisionPromptProps) {
  const t = useTheme();
  useInput((_input, key) => {
    if (key.escape) props.onBack();
  });
  return (
    <Box flexDirection="column">
      <Text color={t.accent}>◇ Revision for {props.specPath}</Text>
      <Text color={t.dim}>(describe the change · esc to go back)</Text>
    </Box>
  );
}
