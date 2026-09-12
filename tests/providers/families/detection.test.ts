import { expect, test } from "bun:test";
import { detectFamily } from "../../../src/providers/families/detection";

test("detects each family from messy real-world ids", () => {
  expect(detectFamily("gpt-oss-20b")?.name).toBe("gpt-oss");
  expect(detectFamily("lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF")?.name).toBe("qwen");
  expect(detectFamily("hf.co/unsloth/gemma-3-27b-it-GGUF:Q4_K_M")?.name).toBe("gemma");
  expect(detectFamily("granite-4.0-h-tiny")?.name).toBe("granite");
});

test("unknown id returns null", () => {
  expect(detectFamily("mistral-7b-instruct")).toBeNull();
});

test("override wins over id matching", () => {
  expect(detectFamily("mistral-7b", "qwen")?.name).toBe("qwen");
  expect(detectFamily("gpt-oss-20b", "gemma")?.name).toBe("gemma");
});

test("adapter exposes preferred format + sampling", () => {
  const qwen = detectFamily("qwen3-coder")!;
  expect(qwen.preferredFormat).toBe("qwen-xml");
  expect(qwen.defaultParams().temperature).toBe(0.7);
});

test("defaultParams returns a fresh copy (not the shared table entry)", () => {
  const a = detectFamily("qwen3-coder")!.defaultParams();
  const b = detectFamily("qwen3-coder")!.defaultParams();
  expect(a).not.toBe(b);
  expect(a).toEqual(b);
});

test("detects the glm family and exposes its config", () => {
  expect(detectFamily("glm-4.7-flash")?.name).toBe("glm");
  const glm = detectFamily("glm-4.6")!;
  expect(glm.preferredFormat).toBe("glm");
  expect(glm.defaultParams()).toEqual({ temperature: 0.6, topP: 0.95 });
  expect(glm.stopSequences).toContain("<|observation|>");
});

test("override resolves the glm adapter", () => {
  expect(detectFamily("mystery-model", "glm")?.name).toBe("glm");
});

test("detects the cohere family and exposes its config", () => {
  expect(detectFamily("north-mini-code-1.0")?.name).toBe("cohere");
  const c = detectFamily("CohereLabs/North-Mini-Code-1.0")!;
  expect(c.preferredFormat).toBe("cohere");
  expect(c.defaultParams()).toEqual({ temperature: 1.0, topP: 0.95 });
});

test("cohere matcher avoids false positives and resolves via override", () => {
  expect(detectFamily("my-command-line-tool")).toBeNull();
  // bare "north" substring must not claim unrelated models
  expect(detectFamily("northstar-llm")).toBeNull();
  expect(detectFamily("Northern-Lights-7B")).toBeNull();
  expect(detectFamily("mystery-model", "cohere")?.name).toBe("cohere");
});

test("detects the muse family across the line and preserves the fallback profile", () => {
  expect(detectFamily("Muse-Glimmer-30B")?.name).toBe("muse");
  expect(detectFamily("meta-models/Muse-Spark-8B")?.name).toBe("muse");
  expect(detectFamily("muse-glimmer-30b-dflash-Q4_K_M")?.name).toBe("muse");
  const muse = detectFamily("Muse-Glimmer-30B")!;
  // preferredFormat mirrors the fallback sniff order (ALL_FORMATS[0]) so parsing is non-regressive.
  expect(muse.preferredFormat).toBe("harmony");
  expect(muse.defaultParams()).toEqual({ temperature: 0.6, topP: 0.95, presencePenalty: 0.5 });
});

test("muse matcher avoids false positives on 'amuse'-style ids", () => {
  expect(detectFamily("amuse-bouche-7b")).toBeNull();
  expect(detectFamily("bemused-llm")).toBeNull();
  expect(detectFamily("mystery-model", "muse")?.name).toBe("muse");
});

test("reasoningDirective delivers each family's effort line, clamping where needed", () => {
  const muse = detectFamily("Muse-Glimmer-30B")!;
  expect(muse.reasoningDirective?.("xhigh")).toBe("Reasoning strength: xhigh");
  expect(muse.reasoningDirective?.("low")).toBe("Reasoning strength: low");
  const gptOss = detectFamily("gpt-oss-20b")!;
  expect(gptOss.reasoningDirective?.("high")).toBe("Reasoning: high");
  // harmony has no xhigh tier — it clamps to high.
  expect(gptOss.reasoningDirective?.("xhigh")).toBe("Reasoning: high");
  // families without an effort directive expose none.
  expect(detectFamily("qwen3-coder")!.reasoningDirective).toBeUndefined();
});
