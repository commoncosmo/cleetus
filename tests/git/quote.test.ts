import { describe, expect, test } from "bun:test";
import { shellJoin, shellQuote } from "../../src/git/quote";

describe("shellQuote", () => {
  test("empty string becomes ''", () => {
    expect(shellQuote("")).toBe("''");
  });
  test("safe tokens pass through unquoted", () => {
    expect(shellQuote("abc")).toBe("abc");
    expect(shellQuote("src/a.ts")).toBe("src/a.ts");
    expect(shellQuote("--force-with-lease")).toBe("--force-with-lease");
    expect(shellQuote("v1.2.3")).toBe("v1.2.3");
  });
  test("spaces force single-quoting", () => {
    expect(shellQuote("a b")).toBe("'a b'");
  });
  test("single quotes are escaped via '\\''", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  test("double quotes are preserved inside single quotes", () => {
    expect(shellQuote('say "hi"')).toBe("'say \"hi\"'");
  });
  test("shell metacharacters are neutralized", () => {
    expect(shellQuote("$HOME")).toBe("'$HOME'");
    expect(shellQuote("`cmd`")).toBe("'`cmd`'");
    expect(shellQuote("a;b|c")).toBe("'a;b|c'");
    expect(shellQuote("*.ts")).toBe("'*.ts'");
    expect(shellQuote("~/x")).toBe("'~/x'");
  });
  test("newlines (multi-line commit message) are kept literal", () => {
    expect(shellQuote("line1\nline2")).toBe("'line1\nline2'");
  });
});

describe("shellJoin", () => {
  test("quotes each element and joins with spaces", () => {
    expect(shellJoin(["git", "commit", "-m", "a b"])).toBe("git commit -m 'a b'");
  });
  test("a message with a quote stays a single safe argument", () => {
    expect(shellJoin(["git", "commit", "-m", "fix: it's broken"])).toBe(
      "git commit -m 'fix: it'\\''s broken'",
    );
  });
});
