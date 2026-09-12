/** A known output pattern that means a *timed-out* process is stuck, not healthy. */
export interface HangSignal {
  /** Matched against the combined stdout+stderr of a timed-out run. */
  pattern: RegExp;
  /** Actionable remediation surfaced to the model in the verdict. */
  hint: string;
}

/**
 * Known stuck-patterns. Seeded with the proven Tauri dev-server-wait (a tauri.conf.json
 * with a devUrl but no beforeDevCommand makes `tauri dev` poll the URL forever). Extend
 * this table as new deterministic hang signals surface in forensics.
 */
export const HANG_SIGNALS: HangSignal[] = [
  {
    pattern: /waiting for (?:your )?(?:the )?(?:frontend )?dev server/i,
    hint:
      "the dev-server URL looks unreachable — nothing is starting it. A Tauri " +
      'tauri.conf.json with a devUrl needs a beforeDevCommand (e.g. "bun run dev") so ' +
      "the frontend actually launches; otherwise `tauri dev` waits forever.",
  },
];

/**
 * Return the first matching signal's hint, or null. Pure; case-insensitivity lives in the
 * patterns. The caller decides relevance — only meaningful for timed-out runs.
 */
export function detectHangSignal(output: string): { hint: string } | null {
  for (const s of HANG_SIGNALS) {
    if (s.pattern.test(output)) return { hint: s.hint };
  }
  return null;
}
