import { Box, type Key, Text, useInput } from "ink";
import { useTheme } from "../theme";

/** The user's keypress at the accepted-spec chooser. Distinct from `SpecExecutionAction` in
 * agent/spec-handoff.ts, which is what the host does with a choice once architecture risk is
 * weighed. */
export type SpecExecutionChoice = "plan" | "orchestrate" | "repair" | "go" | "cancel";

export interface SpecExecutionKeyOptions {
  orchestrationAvailable: boolean;
  orchestrationRetry: boolean;
}

/** Key → choice. Enter defaults to `plan` (the non-destructive option) — unlike BuildPrompt, where
 * enter is go: after accepting a spec, an accidental enter must not launch a direct build.
 * `o` is offered only when orchestration is on; `r` (repair decomposition) only on a retry. */
export function specExecutionKeyAction(
  input: string,
  key: Pick<Key, "return" | "escape">,
  opts: SpecExecutionKeyOptions,
): SpecExecutionChoice | null {
  if (key.return) return "plan";
  if (key.escape) return "cancel";
  switch (input.toLowerCase()) {
    case "p":
      return "plan";
    case "g":
      return "go";
    case "o":
      return opts.orchestrationAvailable ? "orchestrate" : null;
    case "r":
      return opts.orchestrationAvailable && opts.orchestrationRetry ? "repair" : null;
    default:
      return null;
  }
}

/** The key legend, mirroring exactly which keys `specExecutionKeyAction` will honor. */
export function specExecutionControls(opts: SpecExecutionKeyOptions): string {
  const orchestration = opts.orchestrationAvailable
    ? opts.orchestrationRetry
      ? "r repair decomposition · o retry as-is · "
      : ""
    : "";
  const orchestrateKey =
    opts.orchestrationAvailable && !opts.orchestrationRetry ? "o orchestrate · " : "";
  return `${orchestration}enter/p plan · ${orchestrateKey}g go · esc cancel`;
}

export interface SpecExecutionPromptProps extends SpecExecutionKeyOptions {
  onPlan: () => void;
  onOrchestrate: () => void;
  onRepair: () => void;
  onGo: () => void;
  onCancel: () => void;
}

/** Inline control shown once a spec draft is accepted. `plan` drops into plan mode for an
 * implementation plan against the repository; `orchestrate` decomposes to workers; `go` is a direct
 * single-agent build; `cancel` keeps the spec file and stops. */
export function SpecExecutionPrompt(props: SpecExecutionPromptProps) {
  const t = useTheme();
  useInput((input, key) => {
    const choice = specExecutionKeyAction(input, key, props);
    if (choice === "plan") props.onPlan();
    else if (choice === "orchestrate") props.onOrchestrate();
    else if (choice === "repair") props.onRepair();
    else if (choice === "go") props.onGo();
    else if (choice === "cancel") props.onCancel();
  });
  const lead = props.orchestrationRetry
    ? "Orchestration did not start. Choose again."
    : props.orchestrationAvailable
      ? "Spec accepted. Plan, orchestrate, or go?"
      : "Spec accepted. Plan or go?";
  return (
    <Box flexDirection="column">
      <Text color={t.accent}>◇ {lead}</Text>
      <Text color={t.dim}>({specExecutionControls(props)})</Text>
    </Box>
  );
}
