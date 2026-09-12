import { Text } from "ink";
import type React from "react";
import type { Span } from "./types";

/** Render styled spans as adjacent <Text> runs. Inline code uses `codeColor`. */
export function renderSpans(spans: Span[], keyPrefix: string, codeColor: string): React.ReactNode {
  return spans.map((s, i) => (
    <Text
      // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional
      key={`${keyPrefix}-${i}`}
      bold={s.bold}
      italic={s.italic}
      color={s.code ? codeColor : s.color}
    >
      {s.text}
    </Text>
  ));
}
