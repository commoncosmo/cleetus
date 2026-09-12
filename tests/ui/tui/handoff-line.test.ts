import { expect, test } from "bun:test";
import type { Actor } from "../../../src/events/types";
import { formatHandoffLine } from "../../../src/ui/tui/handoff-line";

const worker = (taskId?: string): Actor => ({ role: "worker", taskId });

test("numeric t-id → 'Task N → role: title (M lines)'", () => {
  const text = Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n");
  expect(formatHandoffLine({ text, title: "Verify API Routes" }, worker("t17"))).toBe(
    "↳ Task 17 → worker: Verify API Routes (14 lines)",
  );
});

test("non-numeric task id → no 'Task N' prefix, keeps title", () => {
  const text = Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n");
  expect(formatHandoffLine({ text, title: "Fix: wire tailwind" }, worker("fix-config"))).toBe(
    "↳ worker: Fix: wire tailwind (9 lines)",
  );
});

test("absent task id and title → bare role + line count", () => {
  expect(formatHandoffLine({ text: "only one line" }, worker(undefined))).toBe("↳ worker (1 line)");
});

test("empty text → (0 lines)", () => {
  expect(formatHandoffLine({ text: "" }, worker("t3"))).toBe("↳ Task 3 → worker (0 lines)");
});

test("singular 'line' for a one-line body, plural otherwise", () => {
  expect(formatHandoffLine({ text: "a", title: "T" }, worker("t1"))).toBe(
    "↳ Task 1 → worker: T (1 line)",
  );
  expect(formatHandoffLine({ text: "a\nb", title: "T" }, worker("t1"))).toBe(
    "↳ Task 1 → worker: T (2 lines)",
  );
});
