/** Model round-trips are unlimited unless the user explicitly configures a safety fuse. */
export const DEFAULT_MAX_TOOL_LOOPS = 0;

/**
 * Resolve the effective tool-loop cap from an optional `--max-loops` flag and the config value.
 * `0` (flag or config) means UNLIMITED and resolves to `Infinity`. A flag wins when it is a
 * non-negative integer; anything else is ignored with a warning the caller surfaces. Pure.
 */
export function resolveMaxToolLoops(
  flag: string | undefined,
  configValue: number,
): { value: number; warning?: string } {
  const fromConfig = configValue === 0 ? Number.POSITIVE_INFINITY : configValue;
  if (flag === undefined) return { value: fromConfig };
  const n = Number(flag);
  if (!Number.isInteger(n) || n < 0) {
    return {
      value: fromConfig,
      warning: `invalid --max-loops '${flag}', using ${configValue === 0 ? "unlimited" : configValue}`,
    };
  }
  return { value: n === 0 ? Number.POSITIVE_INFINITY : n };
}

/** Checkpoint-toned message shown when a turn reaches the (finite) tool-call cap without a
 *  model-produced summary. `steps` is always finite here — an unlimited cap never trips. */
export function capCheckpointNote(steps: number): string {
  return `Paused incomplete after reaching the explicit ${steps}-round safety limit. Reply 'continue' to resume with the same session context, or lift the limit with '/maxloops unlimited' (equivalent to '/maxloops 0').`;
}
