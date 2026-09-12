import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/providers/types";
import { toOpenAIMessage } from "../../src/providers/wire";

// Smallest valid PNG (1x1, transparent).
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQB5xW1xAAAAAElFTkSuQmCC",
  "base64",
);

test("plain assistant message maps to role+content", () => {
  const m: Message = { role: "assistant", content: "hi" };
  expect(toOpenAIMessage(m)).toEqual({ role: "assistant", content: "hi" });
});

test("tool message maps to tool_call_id", () => {
  const m: Message = { role: "tool", content: "out", toolCallId: "c1" };
  expect(toOpenAIMessage(m)).toEqual({ role: "tool", tool_call_id: "c1", content: "out" });
});

test("assistant with tool calls maps to tool_calls array", () => {
  const m: Message = {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
  };
  expect(toOpenAIMessage(m)).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
    ],
  });
});

test("reasoning is omitted by default", () => {
  const m: Message = { role: "assistant", content: "hi", reasoning: "thought" };
  expect(toOpenAIMessage(m)).toEqual({ role: "assistant", content: "hi" });
});

test("reasoning is included only when includeReasoning + assistant + present", () => {
  const m: Message = { role: "assistant", content: "hi", reasoning: "thought" };
  expect(toOpenAIMessage(m, { includeReasoning: true })).toEqual({
    role: "assistant",
    content: "hi",
    reasoning: "thought",
  });
  const user: Message = { role: "user", content: "q", reasoning: "x" };
  expect(toOpenAIMessage(user, { includeReasoning: true })).toEqual({ role: "user", content: "q" });
});

test("toOpenAIMessage emits a multimodal array when the message carries images", () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-img-"));
  const path = join(dir, "a.png");
  writeFileSync(path, PNG_1x1);
  const out = toOpenAIMessage({
    role: "user",
    content: "what is this?",
    images: [{ mime: "image/png", path, sha256: "abc" }],
  }) as { role: string; content: Array<Record<string, unknown>> };
  expect(out.role).toBe("user");
  expect(Array.isArray(out.content)).toBe(true);
  expect(out.content[0]).toEqual({ type: "text", text: "what is this?" });
  expect(out.content[1]).toEqual({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${PNG_1x1.toString("base64")}` },
  });
});

test("toOpenAIMessage skips an image whose file is missing instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "wire-img-missing-"));
  const missingPath = join(dir, "does-not-exist.png");
  const out = toOpenAIMessage({
    role: "user",
    content: "what is this?",
    images: [{ mime: "image/png", path: missingPath, sha256: "abc" }],
  }) as { role: string; content: Array<Record<string, unknown>> };
  expect(out.role).toBe("user");
  expect(Array.isArray(out.content)).toBe(true);
  expect(out.content).toEqual([{ type: "text", text: "what is this?" }]);
});

test("toOpenAIMessage leaves a text-only message byte-identical (regression guard)", () => {
  const out = toOpenAIMessage({ role: "user", content: "hello" });
  expect(out).toEqual({ role: "user", content: "hello" });
});
