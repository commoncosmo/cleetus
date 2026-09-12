/** Permission modes the user can switch between at runtime (via `/mode`). */
export type PermissionMode = "normal" | "fuckit" | "plan";

export interface ModeInfo {
  id: PermissionMode;
  /** Short description shown in completions and the picker modal. */
  description: string;
  /** True when picking this mode needs an extra confirmation step. */
  dangerous?: boolean;
}

export const MODES: ModeInfo[] = [
  {
    id: "normal",
    description: "Prompt for writes, edits, and shell; honor permission rules",
  },
  {
    id: "fuckit",
    description: "Disable all permission prompts (DANGEROUS)",
    dangerous: true,
  },
  {
    id: "plan",
    description: "Read-only: investigate and propose a plan, no edits or shell",
  },
];

export function modeInfo(id: PermissionMode): ModeInfo {
  return MODES.find((m) => m.id === id)!;
}

/** Map the internal "permissions disabled" boolean to a mode id. */
export function modeFromDisabled(disabled: boolean): PermissionMode {
  return disabled ? "fuckit" : "normal";
}

/**
 * Compute the prior mode to remember when switching to `next`. Only a genuine transition INTO plan
 * mode (from a non-plan mode) records where we came from; re-entering plan mode while already in it
 * must PRESERVE the original prior mode, otherwise approving a plan (which restores prior mode)
 * becomes a no-op and the session is stuck in plan mode forever. Any other switch leaves it as-is.
 */
export function nextPriorMode(
  current: PermissionMode,
  next: PermissionMode,
  priorMode: PermissionMode,
): PermissionMode {
  return next === "plan" && current !== "plan" ? current : priorMode;
}

/**
 * Resolve a typed `/mode <arg>` to a mode. Accepts an exact id or an
 * unambiguous prefix. Returns null when nothing (or more than one) matches.
 */
export function resolveModeName(arg: string): PermissionMode | null {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  const exact = MODES.find((m) => m.id === a);
  if (exact) return exact.id;
  const prefixed = MODES.filter((m) => m.id.startsWith(a));
  return prefixed.length === 1 ? prefixed[0]!.id : null;
}

export interface ModeCompletion {
  display: string;
  value: string;
}

/** Autocomplete candidates for a `/mode <partial>` line (mirrors completeModelLine). */
export function completeModeLine(line: string): ModeCompletion[] {
  const m = /^\/mode\s+(.*)$/.exec(line);
  if (!m) return [];
  const partial = m[1]!.toLowerCase();
  return MODES.filter((mode) => mode.id.includes(partial)).map((mode) => ({
    display: `${mode.id} — ${mode.description}`,
    value: `/mode ${mode.id}`,
  }));
}
