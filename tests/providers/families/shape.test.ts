import { expect, test } from "bun:test";
import { fallbackStopSequences } from "../../../src/providers/families/registry";
import {
  SAMPLING,
  buildMessagesDefault,
  buildMessagesGemma,
  buildMessagesGptOss,
} from "../../../src/providers/families/shape";
import type { Message } from "../../../src/providers/types";

test("gemma folds system into the first user message", () => {
  const msgs: Message[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
  ];
  expect(buildMessagesGemma(msgs)).toEqual([{ role: "user", content: "SYS\n\nhi" }]);
});

test("gemma with no user message creates a synthetic user turn", () => {
  const msgs: Message[] = [{ role: "system", content: "SYS" }];
  expect(buildMessagesGemma(msgs)).toEqual([{ role: "user", content: "SYS" }]);
});

test("gemma with no system passes through", () => {
  const msgs: Message[] = [{ role: "user", content: "hi" }];
  expect(buildMessagesGemma(msgs)).toEqual([{ role: "user", content: "hi" }]);
});

test("gpt-oss includes assistant reasoning on the wire", () => {
  const msgs: Message[] = [{ role: "assistant", content: "a", reasoning: "thought" }];
  expect(buildMessagesGptOss(msgs)).toEqual([
    { role: "assistant", content: "a", reasoning: "thought" },
  ]);
});

test("default build drops reasoning", () => {
  const msgs: Message[] = [{ role: "assistant", content: "a", reasoning: "thought" }];
  expect(buildMessagesDefault(msgs)).toEqual([{ role: "assistant", content: "a" }]);
});

test("sampling defaults per family", () => {
  expect(SAMPLING.qwen).toEqual({ temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.0 });
  expect(SAMPLING["gpt-oss"]).toEqual({ temperature: 1.0, topP: 1.0 });
  expect(SAMPLING.gemma).toEqual({ temperature: 1.0, topP: 0.95, topK: 64 });
  expect(SAMPLING.granite).toEqual({ temperature: 0.0 });
});

test("fallbackStopSequences stays within the classic OpenAI 4-stop limit", () => {
  // Classic OpenAI-compat servers accept at most 4 `stop` entries; a 5th family stop
  // would be silently truncated there. Growing past 4 requires per-family capping first.
  expect(fallbackStopSequences().length).toBeLessThanOrEqual(4);
});
