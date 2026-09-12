import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme";

export interface PlanApprovalPromptProps {
  onApprove: () => void;
  onEdit: () => void;
  onDismiss: () => void;
}

/** Inline control shown after a plan-mode turn. Enter/a approves, e opens the
 * persisted plan in $EDITOR, and esc dismisses to keep planning. */
export function PlanApprovalPrompt(props: PlanApprovalPromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    if (key.return || input === "a" || input === "A") {
      props.onApprove();
    } else if (input === "e" || input === "E") {
      props.onEdit();
    } else if (key.escape) {
      props.onDismiss();
    }
  });
  return (
    <Box>
      <Text color={t.accent}>◇ Plan ready. </Text>
      <Text color={t.dim}>(enter/a approve, e edit, esc keep planning)</Text>
    </Box>
  );
}
