import { Box, Text } from "ink";
import type { RouteMode } from "../../agent/route-modes";
import { useTheme } from "../theme";
import { useCountUp } from "./use-count-up";

export interface StatusBarProps {
  /** Pre-formatted roster of the model(s) in play (session, or chat/planner/worker when orchestrating). */
  roster: string;
  /** Project name / cwd basename. */
  project: string;
  /** Active session id. */
  sessionId: string;
  /** Running session token totals (from model_call_end usage). */
  tokens: { input: number; output: number };
  /** True when the permission system is disabled (--fuckit or config). */
  fuckit?: boolean;
  /** True when in plan mode (read-only gate). */
  planMode?: boolean;
  /** Current routing mode + the tier used by the last call (hidden in manual mode). */
  route?: { mode: RouteMode; tier: "small" | "large" | null };
  /** Active persona id, shown in the status line. */
  persona?: string;
  /** Active personality/voice id; hidden from the status line when "neutral". */
  personality?: string;
  /** Active launch scope (global/scratch); hidden in normal project mode. */
  launchScope?: "global" | "scratch";
  /** Selected execution boundary, e.g. "Sandbox: Seatbelt". */
  sandboxStatus?: string;
}

/** Status-bar tag for the active launch scope; empty in normal project mode. */
export function formatScopeTag(label?: "global" | "scratch"): string {
  return label ? ` · ${label}` : "";
}

/** Status-bar tag for the selected execution boundary. */
export function formatSandboxTag(status?: string): string {
  return status ? ` · ${status}` : "";
}

/** Quiet chrome below the prompt — informational items on the left, state on the right. */
export function StatusBar({
  roster,
  project,
  sessionId,
  tokens,
  fuckit,
  planMode,
  route,
  persona,
  personality,
  launchScope,
  sandboxStatus,
}: StatusBarProps) {
  const t = useTheme();
  // Counters animate up to each new authoritative total instead of snapping.
  const inTokens = useCountUp(tokens.input);
  const outTokens = useCountUp(tokens.output);
  return (
    <Box flexDirection="column">
      <Text color={t.dim}> {roster}</Text>
      <Box justifyContent="space-between">
        <Text color={t.dim}>
          {" "}
          {project} · session:{sessionId} · in:{inTokens} out:{outTokens}
          {persona ? ` · persona:${persona}` : ""}
          {personality && personality !== "neutral" ? ` · voice:${personality}` : ""}
          {route && route.mode !== "manual"
            ? ` · route:${route.mode}${route.tier ? `(${route.tier})` : ""}`
            : ""}
          {formatScopeTag(launchScope)}
          {formatSandboxTag(sandboxStatus)}
        </Text>
        {planMode ? <Text color={t.accent}>◇ plan </Text> : null}
        {fuckit ? <Text color={t.error}>⚠ fuckit </Text> : null}
      </Box>
    </Box>
  );
}
