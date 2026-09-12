/** One-line warning when teardown left processes alive, or null when the reap was clean.
 *  Shared by smoke_run and bash so the leak is surfaced to the model/user, not silent. */
export function survivorWarning(survivors: number[] | undefined): string | null {
  if (!survivors || survivors.length === 0) return null;
  return `⚠ ${survivors.length} process(es) survived teardown (pids ${survivors.join(", ")}). They may still hold ports; you may need to kill them manually.`;
}
