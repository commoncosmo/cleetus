import { describe, expect, test } from "bun:test";
import type { Session } from "../../src/agent/session";
import { sessionPreview } from "../../src/agent/session-preview";
import type { Event } from "../../src/events/types";

const SESSION: Session = {
  id: "s1",
  createdAt: 1000,
  provider: "lmstudio",
  model: "qwen2.5",
};

function ev(type: Event["type"], payload: unknown): Event {
  return { id: "e", sessionId: "s1", ts: 1000, type, payload };
}

describe("sessionPreview", () => {
  test("uses the first user_input, collapsing whitespace", () => {
    const events = [
      ev("session_start", {}),
      ev("user_input", { text: "add  the\nrun_tests tool" }),
      ev("user_input", { text: "second message" }),
    ];
    const p = sessionPreview(SESSION, events);
    expect(p).toEqual({
      id: "s1",
      model: "qwen2.5",
      preview: "add the run_tests tool",
      createdAt: 1000,
    });
  });

  test("truncates a long preview with an ellipsis", () => {
    const long = "x".repeat(80);
    const p = sessionPreview(SESSION, [ev("user_input", { text: long })]);
    expect(p.preview.length).toBe(60); // 59 chars + …
    expect(p.preview.endsWith("…")).toBe(true);
  });

  test("no user_input yields an empty preview", () => {
    const p = sessionPreview(SESSION, [ev("session_start", {})]);
    expect(p.preview).toBe("");
  });
});
