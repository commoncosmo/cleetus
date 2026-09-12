import { Box, Text, useStdout } from "ink";
import { useTheme } from "../theme";
import { MarkdownTable } from "./MarkdownTable";
import { renderSpans } from "./spans";
import type { MdNode, Span } from "./types";

export interface MarkdownProps {
  nodes: MdNode[];
}

/** Visible character count of a span run — used to size heading underlines. */
function spansWidth(spans: Span[]): number {
  let n = 0;
  for (const s of spans) n += [...s.text].length;
  return n;
}

/** Render a markdown render-model to Ink. Mapping only — no parsing here. */
export function Markdown({ nodes }: MarkdownProps) {
  const { stdout } = useStdout();
  const t = useTheme();
  const termWidth = stdout?.columns ?? 80;
  return (
    <Box flexDirection="column">
      {nodes.map((node, i) => {
        const key = `n-${i}`;
        // Blank line between every block (none before the first).
        const gap = i === 0 ? 0 : 1;
        switch (node.kind) {
          case "heading": {
            const ruleWidth = Math.min(termWidth, Math.max(1, spansWidth(node.spans)));
            return (
              <Box key={key} flexDirection="column" marginTop={gap}>
                <Text bold color={t.heading}>
                  {renderSpans(node.spans, key, t.code)}
                </Text>
                <Text color={t.rule}>{"─".repeat(ruleWidth)}</Text>
              </Box>
            );
          }
          case "paragraph":
            return (
              <Box key={key} marginTop={gap}>
                <Text>{renderSpans(node.spans, key, t.code)}</Text>
              </Box>
            );
          case "blockquote":
            return (
              <Box key={key} marginTop={gap}>
                <Text color={t.dim}>
                  {"│ "}
                  {renderSpans(node.spans, key, t.code)}
                </Text>
              </Box>
            );
          case "rule":
            return (
              <Box key={key} marginTop={gap}>
                <Text color={t.rule}>────────────────</Text>
              </Box>
            );
          case "list":
            return (
              <Box key={key} flexDirection="column" marginTop={gap} marginLeft={2}>
                {node.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: items are positional
                  <Text key={`${key}-${j}`}>
                    {node.ordered ? `${j + 1}. ` : "• "}
                    {renderSpans(item, `${key}-${j}`, t.code)}
                  </Text>
                ))}
              </Box>
            );
          case "code":
            return (
              <Box key={key} flexDirection="column" marginTop={gap} marginLeft={2}>
                {node.lines.map((line, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                  <Text key={`${key}-${j}`}>
                    {line.length === 0 ? " " : renderSpans(line, `${key}-${j}`, t.code)}
                  </Text>
                ))}
              </Box>
            );
          case "table":
            return (
              <Box key={key} marginTop={gap}>
                <MarkdownTable headers={node.headers} rows={node.rows} termWidth={termWidth} />
              </Box>
            );
          default:
            return null;
        }
      })}
    </Box>
  );
}
