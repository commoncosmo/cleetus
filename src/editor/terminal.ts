export interface ReadableTerminalInput {
  read: () => unknown;
  on: (event: "readable", listener: () => void) => unknown;
  off: (event: "readable", listener: () => void) => unknown;
}

export interface DrainEditorInputOptions {
  /** Finish after this many milliseconds without another readable chunk. */
  quietMs?: number;
  /** Hard upper bound when a terminal keeps sending reports. */
  maxMs?: number;
}

/**
 * Consume terminal replies left behind by a foreground editor before Ink
 * re-enables its input listener. Editors query cursor position, device
 * attributes, and terminal colors; a reply that arrives after the editor exits
 * would otherwise become literal text in Cleetus's next prompt.
 */
export function drainEditorInput(
  input: ReadableTerminalInput,
  options: DrainEditorInputOptions = {},
): Promise<void> {
  const quietMs = options.quietMs ?? 75;
  const maxMs = options.maxMs ?? 300;

  return new Promise<void>((resolve) => {
    let finished = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (maxTimer) clearTimeout(maxTimer);
      input.off("readable", handleReadable);
      resolve();
    };

    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };

    const handleReadable = () => {
      while (input.read() !== null) {
        // Intentionally discard handoff-boundary input. Ink has no active input
        // consumer during this interval, so these bytes are terminal replies.
      }
      armQuietTimer();
    };

    input.on("readable", handleReadable);
    const maxTimer = setTimeout(finish, maxMs);
    handleReadable();
  });
}
