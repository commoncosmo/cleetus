import { expect, test } from "bun:test";
import {
  taskListControls,
  taskListEnterAction,
} from "../../../src/ui/tui/task-list-approval-prompt";

test("enter follows an orchestration recommendation", () => {
  expect(taskListEnterAction("orchestrated")).toBe("approve");
});

test("enter follows the safe single-agent fallback for single and hybrid recommendations", () => {
  expect(taskListEnterAction("single")).toBe("go");
  expect(taskListEnterAction("hybrid")).toBe("go");
});

test("a task list offers one revision pass and treats escape as back", () => {
  expect(taskListControls("hybrid", true)).toContain("r revise once");
  expect(taskListControls("hybrid", true)).toContain("esc back");
  expect(taskListControls("hybrid", false)).not.toContain("revise");
  expect(taskListControls("hybrid", false)).toContain("esc back");
});
