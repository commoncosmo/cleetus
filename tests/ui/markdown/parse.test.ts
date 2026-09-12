import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "../../../src/ui/markdown/parse";
import type { MdNode } from "../../../src/ui/markdown/types";

const find = (nodes: MdNode[], kind: MdNode["kind"]) => nodes.find((n) => n.kind === kind);
const spanText = (spans: { text: string }[]) => spans.map((s) => s.text).join("");

describe("parseMarkdown", () => {
  it("returns [] for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });

  it("parses headings with their level", () => {
    const h = find(parseMarkdown("### Title"), "heading");
    expect(h).toBeDefined();
    if (h?.kind === "heading") {
      expect(h.level).toBe(3);
      expect(spanText(h.spans)).toBe("Title");
    }
  });

  it("parses plain text as a single paragraph", () => {
    const nodes = parseMarkdown("just some words");
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe("paragraph");
  });

  it("captures bold, italic, and inline-code spans", () => {
    const p = find(parseMarkdown("**b** _i_ `c`"), "paragraph");
    if (p?.kind === "paragraph") {
      expect(p.spans.some((s) => s.bold && s.text === "b")).toBe(true);
      expect(p.spans.some((s) => s.italic && s.text === "i")).toBe(true);
      expect(p.spans.some((s) => s.code && s.text === "c")).toBe(true);
    }
  });

  it("decodes safe Markdown entities without reintroducing terminal controls", () => {
    const p = find(parseMarkdown("Detroit&#39;s &amp; Wilmette&#x27;s &#27; `&#39;`"), "paragraph");
    if (p?.kind === "paragraph") {
      expect(spanText(p.spans)).toBe("Detroit's & Wilmette's &#27; &#39;");
    }
  });

  it("parses an unordered list", () => {
    const l = find(parseMarkdown("- one\n- two"), "list");
    if (l?.kind === "list") {
      expect(l.ordered).toBe(false);
      expect(l.items).toHaveLength(2);
      expect(spanText(l.items[0]!)).toBe("one");
    }
  });

  it("parses an ordered list", () => {
    const l = find(parseMarkdown("1. a\n2. b"), "list");
    if (l?.kind === "list") expect(l.ordered).toBe(true);
  });

  it("preserves inline formatting inside list items", () => {
    const l = find(parseMarkdown("- **bold** text\n- plain"), "list");
    if (l?.kind === "list") {
      expect(l.items[0]!.some((s) => s.bold && s.text === "bold")).toBe(true);
      expect(spanText(l.items[0]!)).toBe("bold text");
      expect(spanText(l.items[1]!)).toBe("plain");
    }
  });

  it("parses a blockquote and a horizontal rule", () => {
    expect(find(parseMarkdown("> quoted"), "blockquote")).toBeDefined();
    expect(find(parseMarkdown("---"), "rule")).toBeDefined();
  });

  it("parses a fenced code block with its language", () => {
    const c = find(parseMarkdown("```ts\nconst a = 1;\n```"), "code");
    if (c?.kind === "code") {
      expect(c.lang).toBe("ts");
      expect(c.lines.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("parses a GFM table into headers and rows", () => {
    const md = "| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |";
    const t = find(parseMarkdown(md), "table");
    if (t?.kind === "table") {
      expect(t.headers).toHaveLength(2);
      expect(spanText(t.headers[0]!)).toBe("Name");
      expect(t.rows).toHaveLength(2);
      expect(spanText(t.rows[0]![0]!)).toBe("Alice");
    }
  });
});
