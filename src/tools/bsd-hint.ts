/**
 * Reactive BSD/GNU near-miss hint for failed bash calls (#227). When a command fails on macOS
 * because it used a GNU-only flag, return a short corrective hint naming the BSD equivalent. Pure;
 * never throws on ordinary string input. OS-gated by the error signature (BSD says "illegal option",
 * GNU says "invalid option"), so it never needs `process.platform` and never fires on a GNU host.
 */

/** A GNU-only-flag → BSD-equivalent entry. `patterns` are tested against the command string. */
interface Entry {
  patterns: RegExp[];
  line: string;
  /** May also fire on the weak `usage:` / `illegal time format` signals. Only `date`, whose BSD
   *  failure is not "illegal option", needs this; the others require the strong BSD signal so a
   *  weak `usage:` on a GNU/Linux backend can't produce a wrong hint. */
  weakOk?: boolean;
}

// Utility must be the invoked command — anchored to the start of its own simple-command segment
// (start of string, or just after `|`, `;`, `&`, or newline; leading whitespace allowed) — so a
// table utility's name appearing as an argument (a filename, grep pattern, quoted text) does not
// trigger a hint. Matching is heuristic (no real shell tokenization); anchoring is the guard.
function shortFlag(util: string, letter: string): RegExp {
  return new RegExp(`(?:^|[|;&\\n])\\s*${util}\\b[^|;&\\n]*\\s-[A-Za-z]*${letter}[A-Za-z]*\\b`);
}

function longFlag(util: string, flag: string): RegExp {
  return new RegExp(`(?:^|[|;&\\n])\\s*${util}\\b[^|;&\\n]*${flag}\\b`);
}

const TABLE: Entry[] = [
  {
    patterns: [shortFlag("cat", "A"), longFlag("cat", "--show-all")],
    line: "`cat -A` is GNU-only → use `cat -v` (add `-e` for line-ends, `-t` for tabs)",
  },
  {
    patterns: [longFlag("ls", "--color")],
    line: "`ls --color` is GNU-only → use `ls -G` (or set `CLICOLOR=1`)",
  },
  {
    patterns: [shortFlag("sed", "r"), longFlag("sed", "--regexp-extended")],
    line: "`sed -r` is GNU-only → use `sed -E`",
  },
  {
    patterns: [shortFlag("grep", "P"), longFlag("grep", "--perl-regexp")],
    line: "`grep -P` is GNU-only → use `grep -E` (BSD grep has no PCRE)",
  },
  {
    patterns: [shortFlag("date", "d"), longFlag("date", "--date")],
    line: "`date -d` is GNU-only → use `date -r <epoch>` or `date -v` for relative dates",
    weakOk: true,
  },
];

const ILLEGAL_OPTION = /illegal option/i;
const USAGE = /\busage:/i;
const TIME_FORMAT = /illegal time format/i;

const LEAD = "Hint: this host uses BSD coreutils (macOS).";
const GENERIC =
  "Hint: this host uses BSD coreutils (macOS) — some GNU-only flags differ " +
  "(e.g. --color→-G, -r→-E, -P→-E, -A→-v).";

export function bsdHint(command: string, errorOutput: string): string | null {
  if (command.length === 0 || errorOutput.length === 0) return null;

  const strong = ILLEGAL_OPTION.test(errorOutput);
  const weak = USAGE.test(errorOutput) || TIME_FORMAT.test(errorOutput);
  if (!strong && !weak) return null;

  const matched: string[] = [];
  for (const entry of TABLE) {
    // Non-date entries only fire on the strong (BSD-specific) `illegal option` signal; `date` may
    // also fire on the weak `usage:`/time-format signals since its BSD failure isn't "illegal option".
    const eligible = strong || (entry.weakOk === true && weak);
    if (eligible && entry.patterns.some((re) => re.test(command))) matched.push(entry.line);
  }
  if (matched.length > 0) return [LEAD, ...matched].join("\n");

  // Nothing specific matched: only offer the generic pointer on the strong BSD signal, so an
  // unrelated `usage:`/time-format error does not produce a spurious hint.
  if (strong) return GENERIC;
  return null;
}
