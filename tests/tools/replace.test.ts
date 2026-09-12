import { describe, expect, it, test } from "bun:test";
import { applyReplacement, reindent } from "../../src/tools/replace";

describe("applyReplacement", () => {
  it("replaces a single unique occurrence and reports count 1", () => {
    const r = applyReplacement("alpha beta gamma", { oldText: "beta", newText: "BETA" });
    expect(r).toEqual({ ok: true, text: "alpha BETA gamma", count: 1 });
  });

  it("fails when oldText is not found", () => {
    const r = applyReplacement("abc", { oldText: "xyz", newText: "x" });
    expect(r).toEqual({ ok: false, reason: "old_text not found", code: "not_found" });
  });

  it("fails on multiple matches unless replaceAll is set", () => {
    const r = applyReplacement("x x x", { oldText: "x", newText: "y" });
    expect(r).toEqual({
      ok: false,
      reason: "old_text matches 3 times; pass replace_all",
      code: "multiple",
    });
  });

  it("replaces every occurrence and reports the count when replaceAll is true", () => {
    const r = applyReplacement("x x x", { oldText: "x", newText: "y", replaceAll: true });
    expect(r).toEqual({ ok: true, text: "y y y", count: 3 });
  });

  it("inserts newText literally even when it contains $ substitution patterns", () => {
    const r = applyReplacement("price: AMOUNT", { oldText: "AMOUNT", newText: "$&100 $1 $`" });
    expect(r).toEqual({ ok: true, text: "price: $&100 $1 $`", count: 1 });
  });

  it("refuses an empty oldText instead of garbling the file", () => {
    const r = applyReplacement("abc", { oldText: "", newText: "X" });
    expect(r).toEqual({ ok: false, reason: "old_text must not be empty", code: "empty" });
  });

  it("exact match applies and is not flagged whitespace-tolerant", () => {
    expect(applyReplacement("hello world", { oldText: "world", newText: "there" })).toEqual({
      ok: true,
      text: "hello there",
      count: 1,
    });
  });

  it("applies a block that matches only when indentation is ignored, re-indenting new_text", () => {
    const file = "function f() {\n  const a = 1;\n  return a;\n}\n";
    const r = applyReplacement(file, {
      oldText: "    const a = 1;\n    return a;", // model used 4-space indent
      newText: "    const a = 2;\n    return a;",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.whitespaceTolerant).toBe(true);
      expect(r.count).toBe(1);
      expect(r.text).toBe("function f() {\n  const a = 2;\n  return a;\n}\n");
    }
  });

  it("refuses an indentation-insensitive block matching multiple places without replace_all", () => {
    const file = "  x();\nfoo\n    x();\nbar\n";
    const r = applyReplacement(file, { oldText: "\tx();", newText: "y();" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("multiple_ws");
  });

  it("replace_all re-indents each indentation-insensitive site to its own indentation", () => {
    const file = "  x();\n    x();\n";
    const r = applyReplacement(file, { oldText: "\tx();", newText: "\ty();", replaceAll: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.count).toBe(2);
      expect(r.whitespaceTolerant).toBe(true);
      expect(r.text).toBe("  y();\n    y();\n");
    }
  });

  it("returns not_found when the block is genuinely absent even ignoring whitespace", () => {
    const r = applyReplacement("alpha\nbeta\n", { oldText: "gamma", newText: "delta" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("preserves internal relative nesting when shifting the base indentation", () => {
    const file = "obj = {\n  a: {\n    b: 1,\n  },\n}\n";
    const r = applyReplacement(file, {
      oldText: "    a: {\n      b: 1,\n    },", // model over-indented the whole block by 2
      newText: "    a: {\n      b: 2,\n    },",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("obj = {\n  a: {\n    b: 2,\n  },\n}\n");
  });

  it("blank lines in new_text do not acquire trailing whitespace", () => {
    const file = "start\n  keep\nend\n";
    const r = applyReplacement(file, { oldText: "\tkeep", newText: "\tone\n\n\ttwo" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("start\n  one\n\n  two\nend\n");
  });

  it("does not add a trailing newline to a file that lacks one", () => {
    const file = "a\n\tb"; // no trailing newline
    const r = applyReplacement(file, { oldText: "  b", newText: "  c" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a\n\tc");
  });

  it("matches a pattern with a trailing newline when the next file line is non-blank", () => {
    // The py1 forensic case: model's old_text carried a trailing \n, which used to force a
    // phantom blank-line match against `    return 1` and fail a legitimate whitespace-only edit.
    const file = 'def f():\n    """doc."""\n    return 1\n';
    const r = applyReplacement(file, {
      oldText: 'def f():\n     """doc."""\n', // 5-space docstring + trailing newline
      newText: 'def f():\n    """doc!"""\n', // corrected 4-space + trailing newline
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.whitespaceTolerant).toBe(true);
      // No stray blank line inserted between the docstring and `return 1`.
      expect(r.text).toBe('def f():\n    """doc!"""\n    return 1\n');
    }
  });

  it("matches a pattern with a leading blank line when the previous file line is non-blank", () => {
    const file = "a = 1\n  keep\nb = 2\n";
    const r = applyReplacement(file, { oldText: "\n\tkeep", newText: "\n\tdone" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a = 1\n  done\nb = 2\n");
  });

  it("still returns not_found when old_text is entirely blank lines", () => {
    const r = applyReplacement("alpha\nbeta\n", { oldText: "\n\n", newText: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not_found");
  });

  it("prefers the exact match when both an exact and a whitespace-only location exist", () => {
    const file = "\tb\n  b\n"; // tab-indented b, then space-indented b
    const r = applyReplacement(file, { oldText: "  b", newText: "  X" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.whitespaceTolerant).toBeUndefined(); // exact tier used
      expect(r.text).toBe("\tb\n  X\n");
    }
  });

  it("reindent shifts base indentation and preserves relative nesting", () => {
    expect(reindent("    a\n      b", "    ", "  ")).toBe("  a\n    b");
  });

  it("reindent adds file indentation to a zero-indent block", () => {
    expect(reindent("a\n  b", "", "\t")).toBe("\ta\n\t  b");
  });

  it("reindent blanks whitespace-only lines", () => {
    expect(reindent("  a\n   \n  b", "  ", "")).toBe("a\n\nb");
  });

  it("reindent leaves lines less-indented than the anchor unchanged", () => {
    expect(reindent("    a\n  b", "    ", "\t")).toBe("\ta\n  b");
  });

  test("preserves CRLF endings on every line of a whitespace-tolerant edit", () => {
    const file = "function f() {\r\n  const a = 1;\r\n  return a;\r\n}\r\n";
    const r = applyReplacement(file, {
      oldText: "    const a = 1;\n    return a;", // model wrote LF + 4-space indent
      newText: "    const a = 2;\n    return a;",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("function f() {\r\n  const a = 2;\r\n  return a;\r\n}\r\n");
      expect(r.text).not.toMatch(/[^\r]\n/); // no bare LF
      expect(r.text).not.toMatch(/\r\r/); // no doubled CR
    }
  });

  test("CRLF file with no trailing newline keeps its ending style and adds none", () => {
    const file = "a\r\n\tb"; // CRLF, no trailing newline; model indented b with a tab
    const r = applyReplacement(file, { oldText: "  b", newText: "  c" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a\r\n\tc");
  });

  test("LF file remains byte-identical after a whitespace-tolerant edit (no regression)", () => {
    const file = "function f() {\n  const a = 1;\n  return a;\n}\n";
    const r = applyReplacement(file, {
      oldText: "    const a = 1;\n    return a;",
      newText: "    const a = 2;\n    return a;",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("function f() {\n  const a = 2;\n  return a;\n}\n");
  });

  test("replace_all re-terminates every CRLF site consistently", () => {
    const file = "  x();\r\n    x();\r\n";
    const r = applyReplacement(file, { oldText: "\tx();", newText: "\ty();", replaceAll: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("  y();\r\n    y();\r\n");
      expect(r.count).toBe(2);
    }
  });
});
