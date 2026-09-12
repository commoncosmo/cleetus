/**
 * POSIX single-quote a single argument so the shell treats it 100% literally.
 * Safe tokens (letters, digits, and a few shell-inert punctuation chars) pass
 * through unquoted for readability; everything else is wrapped in single quotes,
 * with embedded single quotes escaped as '\'' (close, escaped-quote, reopen).
 */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Join an argv into one shell command string, quoting each element. */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}
