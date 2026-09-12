export interface KeyFlags {
  return?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
}

/** Ink exposes Ctrl+C as input "c" plus the ctrl flag when global exit is disabled. */
export function isClearInputKey(input: string, key: KeyFlags): boolean {
  return input === "c" && key.ctrl === true;
}

/**
 * Detect a "newline, don't submit" keypress across terminal encodings, given what
 * Ink's useInput actually hands us:
 *  - Option+Enter arrives as ESC+CR, which Ink surfaces as input "\r" WITHOUT the
 *    return flag (plain Enter is "\r" WITH the return flag).
 *  - Shift+Enter on modifyOtherKeys terminals (e.g. Ghostty) arrives as "[27;2;13~".
 *  - Terminals that report a genuine modified Enter set return + shift/meta.
 */
export function isNewlineKey(input: string, key: KeyFlags): boolean {
  if (input === "[27;2;13~") return true;
  if (key.return) return Boolean(key.shift || key.meta);
  return input === "\r";
}
