import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "../theme";
import { renderSpans } from "./spans";
import {
  bottomBorder,
  displayWidth,
  fitColumns,
  layoutTable,
  midBorder,
  shouldStack,
  stableTableSpans,
  tableAvailableWidth,
  topBorder,
} from "./table";
import type { Span } from "./types";
import { wrapSpans } from "./wrap";

export interface MarkdownTableProps {
  headers: Span[][];
  rows: Span[][][];
  termWidth: number;
}

const lineWidth = (spans: Span[]): number => spans.reduce((n, s) => n + displayWidth(s.text), 0);

/** Below the grid's minimum width: one "Header: value" block per row. */
function StackedTable({
  headers,
  rows,
  termWidth,
  border,
  label,
  code,
}: {
  headers: Span[][];
  rows: Span[][][];
  termWidth: number;
  border: string;
  label: string;
  code: string;
}): React.ReactNode {
  const labels = headers.map((h) => h.map((s) => s.text).join(""));
  const labelW = labels.reduce((m, l) => Math.max(m, displayWidth(l)), 0);
  const div = "─".repeat(Math.max(8, Math.min(termWidth, 32)));
  const blocks: React.ReactNode[] = [];
  rows.forEach((row, r) => {
    if (r > 0) {
      blocks.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <Text key={`s-div-${r}`} color={border}>
          {div}
        </Text>,
      );
    }
    blocks.push(
      // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
      <Box key={`s-row-${r}`} flexDirection="column">
        {labels.map((lab, c) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
          <Box key={`s-row-${r}-c${c}`} flexDirection="row">
            <Box width={labelW + 2} flexShrink={0}>
              <Text color={label}>{`${lab}:`}</Text>
            </Box>
            <Box flexGrow={1}>
              <Text wrap="wrap">{renderSpans(row[c] ?? [], `s-row-${r}-c${c}`, code)}</Text>
            </Box>
          </Box>
        ))}
      </Box>,
    );
  });
  return <Box flexDirection="column">{blocks}</Box>;
}

/** Render a markdown table as a full box-bordered grid, or stacked when too narrow. */
export function MarkdownTable({ headers, rows, termWidth }: MarkdownTableProps) {
  const t = useTheme();
  const n = headers.length;
  if (n === 0) return null;
  const availableWidth = tableAvailableWidth(termWidth);

  // Decide layout before doing the (cell-iterating) width work — narrow terminals stack.
  if (shouldStack(n, availableWidth)) {
    return (
      <StackedTable
        headers={headers}
        rows={rows}
        termWidth={availableWidth}
        border={t.tableBorder}
        label={t.dim}
        code={t.code}
      />
    );
  }

  // Box grids require deterministic one-column glyphs. Some terminals render emoji one
  // column narrower than Ink measures them, shifting all later vertical separators.
  const gridHeaders = headers.map(stableTableSpans);
  const gridRows = rows.map((row) => row.map(stableTableSpans));
  const natural = layoutTable(gridHeaders, gridRows).widths;
  // Box overhead: " │ " gaps between columns (3) + outer "│ " and " │" (4).
  const widths = fitColumns(natural, availableWidth, 3, 4);

  const renderRow = (cells: Span[][], rowKey: string, bold: boolean): React.ReactNode[] => {
    const wrapped = widths.map((w, c) => wrapSpans(cells[c] ?? [], w));
    const height = Math.max(1, ...wrapped.map((lines) => lines.length));
    const physical: React.ReactNode[] = [];
    for (let k = 0; k < height; k++) {
      const lineKey = `${rowKey}-l${k}`;
      physical.push(
        <Text key={lineKey}>
          <Text color={t.tableBorder}>│ </Text>
          {widths.map((w, c) => {
            const line = wrapped[c]?.[k] ?? [];
            const pad = Math.max(0, w - lineWidth(line));
            const last = c === n - 1;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
              <Text key={`${lineKey}-c${c}`}>
                <Text bold={bold}>{renderSpans(line, `${lineKey}-c${c}`, t.code)}</Text>
                <Text>{" ".repeat(pad)}</Text>
                <Text color={t.tableBorder}>{last ? " │" : " │ "}</Text>
              </Text>
            );
          })}
        </Text>,
      );
    }
    return physical;
  };

  return (
    <Box flexDirection="column">
      <Text color={t.tableBorder}>{topBorder(widths)}</Text>
      {renderRow(gridHeaders, "h", true)}
      <Text color={t.tableBorder}>{midBorder(widths)}</Text>
      {gridRows.flatMap((row, r) => {
        const rowBox = (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <Box key={`r-${r}`} flexDirection="column">
            {renderRow(row, `r${r}`, false)}
          </Box>
        );
        // A rule between every data row so multi-line cells stay visually separated.
        return r === 0
          ? [rowBox]
          : [
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
              <Text key={`r-sep-${r}`} color={t.tableBorder}>
                {midBorder(widths)}
              </Text>,
              rowBox,
            ];
      })}
      <Text color={t.tableBorder}>{bottomBorder(widths)}</Text>
    </Box>
  );
}
