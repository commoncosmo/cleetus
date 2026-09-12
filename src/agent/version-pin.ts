/**
 * Detect a version-pinned framework/library mention (e.g. "Tauri v2", "React 19",
 * "Next.js version 14"). Returns the matched phrase or null. A framework token (a
 * capitalized word, optionally dotted like "Next.js") must be immediately followed by a
 * version token. Tuned toward recall — bare integers count — because the cost of a missed
 * pin (stale-version rewrite) outweighs an occasional gentle reminder on a false positive;
 * the caller additionally gates on a build-request. Pure.
 */
export function detectVersionPin(text: string): string | null {
  const re =
    /\b([A-Z][A-Za-z]+(?:\.[A-Za-z]+)?)\s+(v\d+(?:\.\d+)*|version\s+\d+(?:\.\d+)*|\d+(?:\.\d+)*)\b/;
  const m = re.exec(text);
  return m ? m[0] : null;
}

/** The `<system-reminder>` injected into a turn when a version pin is detected. Pure. */
export function versionPinReminder(phrase: string): string {
  return `<system-reminder>You mentioned ${phrase}. Major versions often differ substantially from earlier ones — verify the current API and conventions for that exact version using your web tools (web_search / web_fetch) before implementing, and ask the user if anything about the version or the requirements is unclear.</system-reminder>`;
}

/**
 * Decide whether to remind for this turn. Returns the pin + reminder text, or null. The
 * caller passes whether the message is a coding task (codingTask) and whether
 * web tools are enabled; the caller is also responsible for once-per-pin de-duplication.
 * Pure.
 */
export function versionPinReminderFor(
  text: string,
  codingTask: boolean,
  webToolsEnabled: boolean,
): { pin: string; reminder: string } | null {
  if (!codingTask || !webToolsEnabled) return null;
  const pin = detectVersionPin(text);
  if (!pin) return null;
  return { pin, reminder: versionPinReminder(pin) };
}
