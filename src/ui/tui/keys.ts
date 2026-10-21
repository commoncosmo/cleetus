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

/** Ctrl+R toggles the live reasoning tail without inserting text into the prompt. */
export function isToggleReasoningKey(input: string, key: KeyFlags): boolean {
  return input === "r" && key.ctrl === true;
}

/** Ctrl+E expands/collapses details for the latest failed test/check. */
export function isToggleTestDetailsKey(input: string, key: KeyFlags): boolean {
  return input === "e" && key.ctrl === true;
}

/**
 * Ctrl+N moves the highlighted option down in any menu (picker modals, the slash-command
 * suggestion list) — the emacs/readline "next" chord, alongside the Down arrow.
 */
export function isMenuNextKey(input: string, key: KeyFlags): boolean {
  return input === "n" && key.ctrl === true;
}

/** Ctrl+P moves the highlighted option up in any menu — the emacs/readline "previous" chord. */
export function isMenuPrevKey(input: string, key: KeyFlags): boolean {
  return input === "p" && key.ctrl === true;
}

/**
 * True when the keypress is one of the menu navigation chords (Ctrl+N/Ctrl+P). Prompts that read a
 * bare letter as a choice must ignore these, so a navigation chord can never be mistaken for a
 * typed "n" (deny/cancel) or "p" (plan) — the mistake a user who just learned the chords is most
 * likely to make. Deliberately narrow: only these two chords, so no other modified key changes.
 */
export function isMenuNavigationKey(input: string, key: KeyFlags): boolean {
  return isMenuNextKey(input, key) || isMenuPrevKey(input, key);
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
