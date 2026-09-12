import { describe, expect, test } from "bun:test";
import type { SessionPreview } from "../../../src/agent/session-preview";
import { sessionRows } from "../../../src/ui/tui/session-row";

const NOW = 10_000;
function p(id: string, createdAt: number, preview: string): SessionPreview {
  return { id, model: "qwen2.5", preview, createdAt };
}

describe("sessionRows", () => {
  test("formats id, time, model, and preview; preserves caller order", () => {
    const rows = sessionRows([p("a", 9_000, "first task"), p("b", 1_000, "older task")], NOW);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]?.label).toContain("a ·");
    expect(rows[0]?.label).toContain("qwen2.5");
    expect(rows[0]?.label).toContain("first task");
  });

  test("empty preview renders (no messages)", () => {
    const rows = sessionRows([p("a", 9_000, "")], NOW);
    expect(rows[0]?.label).toContain("(no messages)");
  });
});
