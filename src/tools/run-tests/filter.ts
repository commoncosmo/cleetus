import type { ResolvedRunner } from "./tool";

/**
 * POSIX single-quote a shell argument so its contents are taken literally — neutralizes any
 * metacharacters. `filter` is model-supplied free text that ends up in a shell-joined command
 * (`sandbox.exec` runs via `bash -c`), so it MUST be quoted to prevent command injection
 * (e.g. a filter of `foo; rm -rf ~`). Embedded single quotes are escaped as `'\''`.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the argv for a focused run that exercises only tests matching `filter` (a test-name
 * pattern/substring). The runner-supplied `filter` is shell-quoted so it is always a single
 * literal argument. Returns `supported: false` (argv unchanged) for runners with no reliable
 * name filter (node script, configured command) — the caller then runs the full suite and notes it.
 */
export function applyFilter(
  runner: ResolvedRunner,
  filter: string,
): { argv: string[]; supported: boolean } {
  const q = shQuote(filter);
  switch (runner.runnerId) {
    case "vitest":
    case "bun":
      return { argv: [...runner.argv, "-t", q], supported: true };
    case "pytest":
      return { argv: [...runner.argv, "-k", q], supported: true };
    case "cargo":
      return { argv: [...runner.argv, q], supported: true };
    case "go": {
      // `go test -run <pat> ./...` — insert before the trailing package selector. Assumes argv
      // ends with that selector, which holds for the only detected go shape (["go","test","./..."]);
      // do not use runnerId "go" with an argv that lacks a trailing package selector.
      const a = [...runner.argv];
      a.splice(a.length - 1, 0, "-run", q);
      return { argv: a, supported: true };
    }
    default:
      return { argv: runner.argv, supported: false };
  }
}
