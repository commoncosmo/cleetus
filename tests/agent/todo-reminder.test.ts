import { expect, test } from "bun:test";
import { renderTodoReminder } from "../../src/agent/todo-reminder";

test("renderTodoReminder: renders the list inside a system-reminder", () => {
  const out = renderTodoReminder([
    { content: "scaffold the app", status: "completed" },
    { content: "wire the API", status: "in_progress" },
    { content: "write tests", status: "pending" },
  ]);
  expect(out.startsWith("<system-reminder>")).toBe(true);
  expect(out.endsWith("</system-reminder>")).toBe(true);
  expect(out).toContain("Current working todo list (restored after history compaction):");
  expect(out).toContain("[x] scaffold the app");
  expect(out).toContain("[→] wire the API");
  expect(out).toContain("[ ] write tests");
});

test("renderTodoReminder: empty list renders nothing", () => {
  expect(renderTodoReminder([])).toBe("");
});
