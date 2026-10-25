/** Remove explicitly labelled source-run observations from learned instructions.
 * Keep rerunnable commands, budgets, and required versions unchanged. */
export function reusableChecks(body: string): string {
  return body
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*(?:[-*]\s+)?(?:recorded|historical|previous[- ]run|source[- ]run) evidence\s*:/i.test(
          line,
        ),
    )
    .join("\n")
    .trim();
}
