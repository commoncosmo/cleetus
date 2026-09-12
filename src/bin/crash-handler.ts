export interface CrashHandlerDeps {
  unmount: () => void;
  logError: (message: string) => void;
  write: (text: string) => void;
  exit: (code: number) => void;
}

/** Build a one-shot crash handler. Runs deps in order: unmount → logError → write → exit.
 *  Re-entrancy guarded (a second call is a no-op); unmount/logError errors are swallowed so
 *  the handler always reaches exit. */
export function makeCrashHandler(deps: CrashHandlerDeps): (err: unknown) => void {
  let handled = false;
  return (err: unknown) => {
    if (handled) return;
    handled = true;
    const e = err instanceof Error ? err : new Error(String(err));
    try {
      deps.unmount();
    } catch {}
    try {
      deps.logError(e.message);
    } catch {}
    deps.write(`\ncleetus crashed: ${e.message}\n${e.stack ?? ""}\n`);
    deps.exit(1);
  };
}
