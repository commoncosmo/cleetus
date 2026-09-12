import { Box, Text, useInput } from "ink";
import {
  type OrchestrationAdmissionReport,
  recommendedAdmissionChoice,
} from "../../agent/orchestration-admission";
import type { PlanTask } from "../../agent/orchestrator";
import { useTheme } from "../theme";

export interface TaskListApprovalPromptProps {
  tasks: PlanTask[];
  admission: OrchestrationAdmissionReport;
  canRevise: boolean;
  onApprove: () => void;
  onGo: () => void;
  onRevise: () => void;
  onDismiss: () => void;
}

export function taskListEnterAction(
  strategy: OrchestrationAdmissionReport["strategy"],
): "approve" | "go" {
  return recommendedAdmissionChoice(strategy) === "workers" ? "approve" : "go";
}

export function taskListControls(
  strategy: OrchestrationAdmissionReport["strategy"],
  canRevise: boolean,
): string {
  const base =
    strategy === "orchestrated"
      ? "enter/a run recommended workers · g use one agent · esc cancel"
      : strategy === "hybrid"
        ? "enter/g run recommended single agent · a force all workers · esc cancel"
        : "enter/g run recommended single agent · a force workers · esc cancel";
  return canRevise
    ? base.replace(" · esc cancel", " · r revise once · esc back")
    : base.replace("esc cancel", "esc back");
}

/** Shown after decomposition and deterministic admission analysis. The recommendation is advisory:
 *  users can still force workers or route the same approved work to one agent. */
export function TaskListApprovalPrompt(props: TaskListApprovalPromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    if (key.return) {
      if (taskListEnterAction(props.admission.strategy) === "approve") props.onApprove();
      else props.onGo();
    } else if (input === "a" || input === "A") props.onApprove();
    else if (input === "g" || input === "G") props.onGo();
    else if (props.canRevise && (input === "r" || input === "R")) props.onRevise();
    else if (key.escape) props.onDismiss();
  });
  const recommendation =
    props.admission.strategy === "orchestrated"
      ? "orchestrated workers"
      : props.admission.strategy === "hybrid"
        ? "single agent (hybrid staging unavailable)"
        : "single agent";
  const summary =
    props.admission.strategy === "hybrid"
      ? "This plan has a hybrid shape, but staged lead-then-workers execution is not available."
      : props.admission.summary;
  const evidence = [...props.admission.reasons.slice(0, 1), ...props.admission.risks.slice(0, 2)];
  const controls = taskListControls(props.admission.strategy, props.canRevise);
  return (
    <Box flexDirection="column">
      <Text color={t.accent}>◇ Orchestration plan ({props.tasks.length} tasks):</Text>
      {props.tasks.map((task, i) => (
        <Text key={task.id} color={t.dim}>
          {"  "}
          {i + 1}. {task.title} [{task.agentType}]
        </Text>
      ))}
      <Text color={t.heading}>
        Recommendation: {recommendation} ({Math.round(props.admission.confidence * 100)}%
        confidence)
      </Text>
      <Text color={t.dim}>{summary}</Text>
      {evidence.map((item) => (
        <Text key={item} color={t.dim}>
          {"  • "}
          {item}
        </Text>
      ))}
      <Text color={t.dim}>({controls})</Text>
    </Box>
  );
}
