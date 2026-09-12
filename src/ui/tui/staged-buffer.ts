/** A mutable "ref box" shape compatible with a React `useRef<T[]>` — just its `.current`. */
export interface StagedBox<T> {
  current: T[];
}

/**
 * Snapshot-and-clear a staged-items ref box synchronously (no `await` in between). Returns the
 * items staged *before* the call and empties the box in the same tick, so a second call against
 * the same box — e.g. a second `runPrompt` invocation inside one user submit — sees an empty
 * buffer instead of re-reading a stale, still-populated value and re-attaching the same items to
 * a turn they were never meant for.
 */
export function takeStaged<T>(box: StagedBox<T>): T[] {
  const snapshot = box.current;
  box.current = [];
  return snapshot;
}
