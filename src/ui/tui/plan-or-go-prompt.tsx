import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme";

export interface BuildPromptProps {
  /** Whether the Orchestrate option is offered for this submission. */
  showOrchestrate: boolean;
  orchestrationRetry?: boolean;
  onOrchestrate: () => void;
  onRepair: () => void;
  onPlan: () => void;
  onGo: () => void;
  onCancel: () => void;
}

/** Inline pre-turn control for a build request. o → orchestrate (when offered); p → plan first;
 *  g/enter → just go (single agent); esc → cancel (abandon the turn, no mode change). */
export function BuildPrompt(props: BuildPromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    if (props.showOrchestrate && (input === "o" || input === "O")) props.onOrchestrate();
    else if (props.orchestrationRetry && (input === "r" || input === "R")) props.onRepair();
    else if (input === "p" || input === "P") props.onPlan();
    else if (key.return || input === "g" || input === "G") props.onGo();
    else if (key.escape) props.onCancel();
  });
  const orchPart = props.showOrchestrate
    ? props.orchestrationRetry
      ? "r repair decomposition · o retry as-is · "
      : "o orchestrate · "
    : "";
  const lead = props.showOrchestrate
    ? props.orchestrationRetry
      ? "Orchestration did not start. Retry, plan, or just go? "
      : "Build request. Orchestrate, plan, or just go? "
    : "Build request. Plan first or just go? ";
  return (
    <Box>
      <Text color={t.accent}>◇ {lead}</Text>
      <Text color={t.dim}>({orchPart}p plan · g/enter go · esc cancel)</Text>
    </Box>
  );
}
