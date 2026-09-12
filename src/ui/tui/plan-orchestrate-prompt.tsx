import { Box, Text, useInput } from "ink";
import { useTheme } from "../theme";

export interface PlanOrchestratePromptProps {
  orchestrationRetry?: boolean;
  onOrchestrate: () => void;
  onRepair: () => void;
  onGo: () => void;
  onCancel: () => void;
}

/** Inline post-plan-approval control. o → orchestrate the approved plan; g/enter → just go
 *  (implement on the chat model); esc → cancel (leave the plan un-implemented, no turn). */
export function PlanOrchestratePrompt(props: PlanOrchestratePromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    if (input === "o" || input === "O") props.onOrchestrate();
    else if (props.orchestrationRetry && (input === "r" || input === "R")) props.onRepair();
    else if (key.return || input === "g" || input === "G") props.onGo();
    else if (key.escape) props.onCancel();
  });
  return (
    <Box>
      <Text color={t.accent}>
        ◇{" "}
        {props.orchestrationRetry
          ? "Orchestration did not start. Retry or just go? "
          : "Plan approved. Orchestrate or just go? "}
      </Text>
      <Text color={t.dim}>
        {props.orchestrationRetry
          ? "(r repair decomposition · o retry as-is · g/enter go · esc cancel)"
          : "(o orchestrate · g/enter go · esc cancel)"}
      </Text>
    </Box>
  );
}
