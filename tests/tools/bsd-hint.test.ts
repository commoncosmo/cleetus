import { describe, expect, it } from "bun:test";
import { bsdHint } from "../../src/tools/bsd-hint";

describe("bsdHint", () => {
  it("targets cat -A on an illegal option failure", () => {
    const h = bsdHint("cat -A tsconfig.json", "cat: illegal option -- A");
    expect(h).toContain("BSD coreutils");
    expect(h).toContain("cat -v");
    expect(h).not.toContain("ls -G");
    expect(h).not.toContain("sed -E");
  });

  it("matches a bundled short cluster (cat -nA)", () => {
    expect(bsdHint("cat -nA f", "cat: illegal option -- A")).toContain("cat -v");
  });

  it("matches ls --color via the command, not the mangled error char", () => {
    expect(bsdHint("ls --color -la", "ls: illegal option -- -")).toContain("ls -G");
  });

  it("matches sed -r and grep -P", () => {
    expect(bsdHint("sed -r 's/a/b/' f", "sed: illegal option -- r")).toContain("sed -E");
    expect(bsdHint("grep -P foo f", "grep: illegal option -- P")).toContain("grep -E");
  });

  it("matches date -d on a usage / time-format signature (no 'illegal option')", () => {
    const h = bsdHint("date -d yesterday", "date: illegal time format\nusage: date ...");
    expect(h).toContain("date -r");
  });

  it("matches long-form aliases", () => {
    expect(bsdHint("sed --regexp-extended 's/a/b/' f", "sed: illegal option -- -")).toContain(
      "sed -E",
    );
    expect(bsdHint("grep --perl-regexp x f", "grep: illegal option -- -")).toContain("grep -E");
    expect(bsdHint("ls --color=auto", "ls: illegal option -- -")).toContain("ls -G");
    expect(bsdHint("date --date=yesterday", "usage: date ...")).toContain("date -r");
  });

  it("falls back to a generic line for an unmapped flag on illegal option", () => {
    const h = bsdHint("frobnicate --frobnicate", "frobnicate: illegal option -- -");
    expect(h).toContain("BSD coreutils");
    expect(h).not.toContain("cat -v");
  });

  it("returns null for a bare usage error with no known token", () => {
    expect(bsdHint("grep", "usage: grep [-abcd] ...")).toBeNull();
  });

  it("returns null for ordinary failures", () => {
    expect(bsdHint("cat missing.txt", "cat: missing.txt: No such file or directory")).toBeNull();
  });

  it("returns null for empty inputs", () => {
    expect(bsdHint("", "illegal option")).toBeNull();
    expect(bsdHint("cat -A f", "")).toBeNull();
  });

  it("does not mis-fire on a table-utility name appearing as an argument", () => {
    // grep is the failing command; `date` is just a filename → no date hint, generic fallback only
    const h1 = bsdHint("grep pattern date.txt -d", "grep: illegal option -- d");
    expect(h1).not.toContain("date -r");
    expect(h1).toContain("BSD coreutils"); // generic fallback on illegal option

    // ls is the failing command; `cat.txt` is a filename → no cat hint
    const h2 = bsdHint("ls cat.txt -A", "ls: illegal option -- A");
    expect(h2).not.toContain("cat -v");

    // quoted text mentioning a GNU flag for an unrelated program → no hint from the quote
    const h3 = bsdHint('echo "cat -A is bad"', "echo: illegal option -- x");
    expect(h3).not.toContain("cat -v");
  });

  it("still matches the invoked command after a pipe", () => {
    expect(bsdHint("sed -n p f | cat -A", "cat: illegal option -- A")).toContain("cat -v");
  });

  it("does not emit a targeted hint on a weak usage: signal for a non-date utility (Linux-safe)", () => {
    // On a GNU/Linux backend `sed -r` is valid; a later command failing with `usage:` (no
    // "illegal option") must NOT produce a `sed -E` hint.
    const h = bsdHint("sed -r 's/a/b/' f | column -x", "usage: column [-tx] [-c columns]");
    expect(h).toBeNull();
  });
});
