import { common, createLowlight } from "lowlight";
import { type Theme, themes } from "../theme";
import type { Span, StyledLine } from "./types";

const lowlight = createLowlight(common);

function scopeColor(classes: string[], c: Theme["syntax"]): string | undefined {
  for (const cls of classes) {
    const scope = cls.startsWith("hljs-") ? cls.slice(5) : cls;
    if (scope === "keyword" || scope === "built_in" || scope === "literal") return c.keyword;
    if (scope === "string" || scope === "regexp" || scope === "char") return c.string;
    if (scope === "comment") return c.comment;
    if (scope === "number") return c.number;
    if (scope === "title" || scope === "function" || scope === "title.function") return c.function;
    if (scope === "attr" || scope === "attribute" || scope === "property") return c.attr;
  }
  return undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: hast node shape from lowlight
function walk(node: any, color: string | undefined, out: Span[], c: Theme["syntax"]): void {
  if (node.type === "text") {
    if (node.value) out.push(color ? { text: node.value, color } : { text: node.value });
    return;
  }
  if (node.type === "element") {
    const classes: string[] = node.properties?.className ?? [];
    const next = scopeColor(classes, c) ?? color;
    for (const child of node.children ?? []) walk(child, next, out, c);
    return;
  }
  for (const child of node.children ?? []) walk(child, color, out, c);
}

function splitLines(spans: Span[]): StyledLine[] {
  const lines: StyledLine[] = [[]];
  for (const sp of spans) {
    const parts = sp.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i]!.length > 0) {
        lines[lines.length - 1]!.push(
          sp.color ? { text: parts[i]!, color: sp.color } : { text: parts[i]! },
        );
      }
    }
  }
  return lines;
}

/**
 * Syntax-highlight a code block into styled lines. Known languages are colored
 * via lowlight; unknown/missing languages (or any failure) fall back to plain
 * uncolored spans. The concatenated text of each line equals the source line.
 */
export function highlightCode(
  code: string,
  lang?: string,
  syntax: Theme["syntax"] = themes.dark.syntax,
): StyledLine[] {
  if (!lang || !lowlight.registered(lang)) {
    return code.split("\n").map((line) => (line.length > 0 ? [{ text: line }] : []));
  }
  try {
    const tree = lowlight.highlight(lang, code);
    const flat: Span[] = [];
    for (const child of tree.children) walk(child, undefined, flat, syntax);
    return splitLines(flat);
  } catch {
    return code.split("\n").map((line) => (line.length > 0 ? [{ text: line }] : []));
  }
}
