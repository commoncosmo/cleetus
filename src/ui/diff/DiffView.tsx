import { Box, Text } from "ink";
import { useTheme } from "../theme";
import { toHunks } from "./hunks";
import { diffLines } from "./lcs";

export interface DiffViewProps {
  diff: { path: string; before: string; after: string };
}

/** Render a unified, changed-only red/green diff. Returns null for a no-op diff. */
export function DiffView({ diff }: DiffViewProps) {
  const t = useTheme();
  const ops = diffLines(diff.before, diff.after);
  if (!ops.some((o) => o.op !== "eq")) return null;
  const { hunks, truncated } = toHunks(ops);

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={t.dim}>
        ─ {diff.path}
        {diff.before === "" ? " (new file)" : ""} ─
      </Text>
      {hunks.map((hunk, h) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks are positional
        <Box key={`h-${h}`} flexDirection="column">
          {h > 0 && <Text color={t.dim}>⋯</Text>}
          {hunk.ops.map((op, i) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: op lines are positional
              key={`h-${h}-${i}`}
              color={op.op === "add" ? t.success : op.op === "del" ? t.error : t.dim}
            >
              {op.op === "add" ? "+ " : op.op === "del" ? "- " : "  "}
              {op.text}
            </Text>
          ))}
        </Box>
      ))}
      {truncated > 0 && <Text color={t.dim}>… {truncated} more changed lines</Text>}
    </Box>
  );
}
