/** Pure helpers for the interactive spec-creator (`/spec`). They compose the text seeded into the
 *  LIVE turn — the deterministic bits (today's date, the resolved write path) that a small model
 *  gets wrong. All spec-writing intelligence lives in the `spec-creator` skill playbook, not here. */

/** Today's local date as `YYYY-MM-DD`, zero-padded. Injected `now` keeps it testable. */
export function specDatePrefix(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Compose the seeded turn: the command as the user typed it, then — inside a `<system-reminder>`
 *  so the transcript shows only the user's words (#316) — the playbook body, a resolved write-path
 *  instruction (the model fills the `<slug>`), and the user's rough idea (or a note to ask for one). */
export function buildSpecTurn(input: {
  playbookBody: string;
  specsDir: string;
  datePrefix: string;
  idea: string;
  orchestrationAvailable: boolean;
}): string {
  const { playbookBody, specsDir, datePrefix, idea, orchestrationAvailable } = input;
  const dir = specsDir.replace(/\/+$/, ""); // tolerate a config value with a trailing slash
  const trimmed = idea.trim();
  const ideaLine = trimmed
    ? `The user's rough idea: ${trimmed}`
    : "The user gave no initial idea — open by asking what they want to spec.";
  const orchNote = orchestrationAvailable
    ? ""
    : "\n\nOrchestration is currently unavailable — in your closing handoff, offer only `plan` and `go` (omit `orchestrate`).";
  const visible = trimmed ? `/spec ${trimmed}` : "/spec";
  const injected = [
    playbookBody.trim(),
    "",
    `Write the finished spec to a new file at \`${dir}/${datePrefix}-<slug>.md\`, choosing a short kebab-case \`<slug>\` from the agreed topic.`,
    "",
    ideaLine,
    orchNote,
  ].join("\n");
  return `${visible}\n\n<system-reminder>\n${injected}\n</system-reminder>`;
}
