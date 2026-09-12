import { marked } from "marked";
import type { Theme } from "../theme";
import { highlightCode } from "./highlight";
import type { MdNode, Span } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: marked inline token shapes
type Tok = any;

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

function decodeMarkdownEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|apos|gt|lt|quot));/giu,
    (source, decimal: string | undefined, hexadecimal: string | undefined, named?: string) => {
      if (named) return ENTITIES[named.toLowerCase()] ?? source;
      const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", decimal ? 10 : 16);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0x20 ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        codePoint > 0x10ffff
      ) {
        return source;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

/** Flatten marked inline tokens into styled spans. */
function inlineSpans(tokens: Tok[] | undefined, style: Partial<Span> = {}): Span[] {
  if (!tokens) return [];
  const out: Span[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "strong":
        out.push(...inlineSpans(t.tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlineSpans(t.tokens, { ...style, italic: true }));
        break;
      case "del":
        out.push(...inlineSpans(t.tokens, style));
        break;
      case "codespan":
        out.push({ ...style, text: t.text, code: true });
        break;
      case "link": {
        const label = decodeMarkdownEntities(t.text ?? "");
        out.push({ ...style, text: label });
        if (t.href && t.href !== label) {
          out.push({ ...style, text: ` (${decodeMarkdownEntities(t.href)})` });
        }
        break;
      }
      case "br":
        out.push({ ...style, text: "\n" });
        break;
      case "text":
        // A block-level `text` token (e.g. list-item content) carries its inline
        // content under `.tokens`; recurse so emphasis inside it is preserved.
        if (Array.isArray(t.tokens) && t.tokens.length > 0) {
          out.push(...inlineSpans(t.tokens, style));
        } else {
          out.push({ ...style, text: decodeMarkdownEntities(t.text ?? t.raw ?? "") });
        }
        break;
      default:
        out.push({ ...style, text: decodeMarkdownEntities(t.text ?? t.raw ?? "") });
    }
  }
  return out;
}

const cellSpans = (cell: Tok): Span[] => inlineSpans(cell.tokens);

// A blockquote's inner tokens are block tokens; flatten their inline content.
function blockquoteSpans(t: Tok): Span[] {
  const out: Span[] = [];
  for (const inner of t.tokens ?? []) {
    if (inner.tokens) out.push(...inlineSpans(inner.tokens));
    else if (inner.text) out.push({ text: inner.text });
  }
  return out;
}

/** Parse markdown source into the intermediate render model. */
export function parseMarkdown(src: string, syntax?: Theme["syntax"]): MdNode[] {
  if (!src) return [];
  const tokens = marked.lexer(src);
  const nodes: MdNode[] = [];
  for (const t of tokens as Tok[]) {
    switch (t.type) {
      case "heading":
        nodes.push({
          kind: "heading",
          level: Math.min(Math.max(t.depth, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6,
          spans: inlineSpans(t.tokens),
        });
        break;
      case "paragraph":
        nodes.push({ kind: "paragraph", spans: inlineSpans(t.tokens) });
        break;
      case "text":
        nodes.push({
          kind: "paragraph",
          spans: t.tokens ? inlineSpans(t.tokens) : [{ text: t.text ?? "" }],
        });
        break;
      case "code":
        nodes.push({
          kind: "code",
          lang: t.lang || undefined,
          lines: highlightCode(t.text ?? "", t.lang || undefined, syntax),
        });
        break;
      case "list":
        nodes.push({
          kind: "list",
          ordered: Boolean(t.ordered),
          items: (t.items ?? []).map((it: Tok) => inlineSpans(it.tokens)),
        });
        break;
      case "blockquote":
        nodes.push({ kind: "blockquote", spans: blockquoteSpans(t) });
        break;
      case "table":
        nodes.push({
          kind: "table",
          headers: (t.header ?? []).map(cellSpans),
          rows: (t.rows ?? []).map((row: Tok[]) => row.map(cellSpans)),
        });
        break;
      case "hr":
        nodes.push({ kind: "rule" });
        break;
      case "space":
        break;
      default:
        if (t.raw?.trim()) nodes.push({ kind: "paragraph", spans: [{ text: t.raw.trim() }] });
    }
  }
  return nodes;
}
