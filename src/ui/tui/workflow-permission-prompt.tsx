import { Box, Text, useInput } from "ink";
import type { WorkflowAuthorizationDecision } from "../../workflows/service";
import type { WorkflowAuthorizationRequest } from "../cli/workflow";
import { useTheme } from "../theme";

export interface WorkflowPermissionPromptProps {
  request: WorkflowAuthorizationRequest;
  onResolve: (decision: WorkflowAuthorizationDecision) => void;
}

/** One bounded, consolidated checkpoint for the complete exact-revision authority envelope. */
export function WorkflowPermissionPrompt({ request, onResolve }: WorkflowPermissionPromptProps) {
  const theme = useTheme();
  const lines = request.dryRun.summary.split("\n").slice(0, 8);
  useInput((input, key) => {
    if (input === "y") onResolve("allow_once");
    else if (input === "t") onResolve("trust_revision");
    else if (input === "n" || key.escape) onResolve("deny");
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      height={Math.min(14, lines.length + 6)}
    >
      <Text bold color={theme.warning}>
        Run workflow: {request.plan.package.name}
      </Text>
      <Text color={theme.dim}>
        revision {request.plan.package.manifest.revision} ·{" "}
        {request.plan.package.executionHash.slice(0, 12)}
      </Text>
      {lines.map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      <Text>
        [<Text color={theme.success}>y</Text>] allow once · [<Text color={theme.accent}>t</Text>]
        trust exact revision · [<Text color={theme.error}>n</Text>] deny
      </Text>
    </Box>
  );
}
