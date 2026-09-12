import { Box, Text } from "ink";
import { todoGlyph } from "../../tools/todo-core";
import type { TodoItem } from "../../tools/types";
import { useTheme } from "../theme";

/** Render a todo checklist as an indented transcript block. `title` labels a named
 * list (e.g. "groceries (project)"); when absent it is the session working list. */
export function TodoView({ todos, title }: { todos: TodoItem[]; title?: string }) {
  const t = useTheme();
  const done = todos.filter((x) => x.status === "completed").length;
  if (todos.length === 0) {
    return (
      <Box>
        <Text color={t.dim}>
          {"    "}
          {title ? `${title} — empty.` : "Todo list cleared."}
        </Text>
      </Box>
    );
  }
  const header = title
    ? `${title} — ${done}/${todos.length} done:`
    : `Todos (${done}/${todos.length} done):`;
  return (
    <Box flexDirection="column">
      <Text color={t.dim}>
        {"    "}
        {header}
      </Text>
      {todos.map((item, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: todo rows are positional, not identities
          key={i}
          color={
            item.status === "completed"
              ? t.dim
              : item.status === "in_progress"
                ? t.accent
                : undefined
          }
        >
          {"    "}
          {todoGlyph(item.status)} {item.content}
        </Text>
      ))}
    </Box>
  );
}
