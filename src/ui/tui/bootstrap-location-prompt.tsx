import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme";

export interface BootstrapLocationPromptProps {
  suggestedName: string;
  onCwd: () => void;
  onSubdir: () => void;
  onDismiss: () => void;
}

/** Inline pre-orchestration control on a fresh bootstrap target: c → scaffold into the current
 *  directory; s → scaffold into a suggested subdirectory; esc → dismiss (no structuring). */
export function BootstrapLocationPrompt(props: BootstrapLocationPromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    // With Ink's global Ctrl+C exit disabled, modified characters reach every
    // active input handler. Do not mistake Ctrl+C for the plain `c` choice.
    if (key.ctrl || key.meta) return;
    if (input === "c" || input === "C") props.onCwd();
    else if (input === "s" || input === "S") props.onSubdir();
    else if (key.escape) props.onDismiss();
  });
  return (
    <Box>
      <Text color={t.accent}>
        ◇ Fresh directory — scaffold into the current directory (`.`) or a subdirectory (`./
        {props.suggestedName}`)?{" "}
      </Text>
      <Text color={t.dim}>(c cwd · s subdir · esc dismiss)</Text>
    </Box>
  );
}
