import { describe, expect, it } from "bun:test";
import { applyEffort } from "../../src/agent/effort";
import type { ChatOptions } from "../../src/providers/types";

function baseReq(model: string, withSystem = true): ChatOptions {
  return {
    model,
    messages: [
      ...(withSystem ? [{ role: "system" as const, content: "be terse" }] : []),
      { role: "user" as const, content: "hi" },
    ],
  };
}

describe("applyEffort", () => {
  it("sets reasoningEffort for a non-gpt-oss model and adds no harmony line", () => {
    const out = applyEffort(baseReq("llama-3.1-8b"), "high");
    expect(out.reasoningEffort).toBe("high");
    const sys = out.messages.find((m) => m.role === "system")!;
    expect(sys.content).toBe("be terse");
    expect(out.messages.some((m) => m.content.includes("Reasoning:"))).toBe(false);
  });

  it("sets reasoningEffort AND appends a harmony line for a gpt-oss model", () => {
    const out = applyEffort(baseReq("gpt-oss-20b"), "low");
    expect(out.reasoningEffort).toBe("low");
    const sys = out.messages.find((m) => m.role === "system")!;
    expect(sys.content).toBe("be terse\n\nReasoning: low");
  });

  it("matches gpt-oss case-insensitively", () => {
    const out = applyEffort(baseReq("My-GPT-OSS-120B"), "medium");
    const sys = out.messages.find((m) => m.role === "system")!;
    expect(sys.content).toContain("Reasoning: medium");
  });

  it("prepends a system message for a gpt-oss request that has none", () => {
    const out = applyEffort(baseReq("gpt-oss-20b", false), "high");
    expect(out.messages[0]).toEqual({ role: "system", content: "Reasoning: high" });
    expect(out.messages[1]!.role).toBe("user");
  });

  it("appends Muse's Reasoning strength line and clamps xhigh on the wire", () => {
    const out = applyEffort(baseReq("meta-models/Muse-Glimmer-30B"), "xhigh");
    // xhigh is Muse-specific: it rides the system line, not the OpenAI body param.
    expect(out.reasoningEffort).toBe("high");
    const sys = out.messages.find((m) => m.role === "system")!;
    expect(sys.content).toBe("be terse\n\nReasoning strength: xhigh");
  });

  it("carries the full level for Muse at standard tiers", () => {
    const out = applyEffort(baseReq("Muse-Spark-8B"), "high");
    expect(out.reasoningEffort).toBe("high");
    const sys = out.messages.find((m) => m.role === "system")!;
    expect(sys.content).toBe("be terse\n\nReasoning strength: high");
  });

  it("clamps xhigh to high inside the gpt-oss harmony line (harmony has no xhigh)", () => {
    const out = applyEffort(baseReq("gpt-oss-20b"), "xhigh");
    expect(out.reasoningEffort).toBe("high");
    const sys = out.messages.find((m) => m.role === "system")!;
    expect(sys.content).toBe("be terse\n\nReasoning: high");
  });

  it("does not mutate the input request or its messages", () => {
    const req = baseReq("gpt-oss-20b");
    const snapshot = JSON.stringify(req);
    applyEffort(req, "high");
    expect(JSON.stringify(req)).toBe(snapshot);
    expect(req.reasoningEffort).toBeUndefined();
  });
});
