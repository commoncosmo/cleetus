import { Box, Text, useInput } from "ink";
import type { TodoSnapshot } from "../../agent/todo-snapshot";
import { renderTodoItemLines } from "../../tools/todo-core";
import { useTheme } from "../theme";
import { formatAge } from "./format-age";

export interface RestorePromptProps {
  snapshot: TodoSnapshot;
  onRestore: () => void;
  onDismiss: () => void;
}

/** Startup modal offering to restore an unfinished todo list from a prior session.
 * y/enter restores; n/esc dismisses. Shown at most once per launch. */
export function RestorePrompt(props: RestorePromptProps) {
  const t = useTheme();
  const { todos, updatedAt } = props.snapshot;
  const done = todos.filter((x) => x.status === "completed").length;

  useInput((input, key) => {
    if (key.return || input === "y" || input === "Y") {
      props.onRestore();
    } else if (key.escape || input === "n" || input === "N") {
      props.onDismiss();
    }
  });

  return (
    <Box flexDirection="column">
      <Text>
        Restore todo list from {formatAge(Date.now() - updatedAt)} — {done}/{todos.length} done?{" "}
        <Text color={t.dim}>(y/enter restore, n/esc dismiss)</Text>
      </Text>
      {renderTodoItemLines(todos).map((line, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: todo rows are positional, not identities
          key={i}
          color={t.dim}
        >
          {"  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
