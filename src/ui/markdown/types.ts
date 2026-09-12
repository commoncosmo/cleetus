/** A run of text with optional inline styling. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Inline code styling (rendered dim/gray). */
  code?: boolean;
  /** Ink color name — used by syntax-highlighted code spans. */
  color?: string;
}

/** One line of a code block, as styled spans. */
export type StyledLine = Span[];

/** A block-level markdown node in the intermediate render model. */
export type MdNode =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "code"; lang?: string; lines: StyledLine[] }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "table"; headers: Span[][]; rows: Span[][][] }
  | { kind: "blockquote"; spans: Span[] }
  | { kind: "rule" };
