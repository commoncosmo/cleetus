import { describe, expect, it } from "bun:test";
import {
  DEFAULT_EFFORT,
  EFFORTS,
  applyEffort,
  completeEffortLine,
  resolveEffortName,
  resolveStartEffort,
} from "../../src/agent/effort";
import type { ChatOptions } from "../../src/providers/types";

const reqFor = (model: string): ChatOptions => ({
  model,
  messages: [{ role: "user", content: "hi" }],
});

describe("applyEffort", () => {
  it("sets reasoningEffort for a normal (thinking) model", () => {
    expect(applyEffort(reqFor("qwen3.6:35b"), "high").reasoningEffort).toBe("high");
  });

  it("omits reasoningEffort for a non-thinking family (granite)", () => {
    expect(applyEffort(reqFor("granite4.1:30b"), "medium").reasoningEffort).toBeUndefined();
  });

  it("omits reasoningEffort when the model is in the session no-think set", () => {
    const noThink = new Set(["mystery-model:latest"]);
    expect(
      applyEffort(reqFor("mystery-model:latest"), "medium", noThink).reasoningEffort,
    ).toBeUndefined();
  });

  it("still sets reasoningEffort for a model NOT in the no-think set", () => {
    const noThink = new Set(["other-model"]);
    expect(applyEffort(reqFor("qwen3.6:35b"), "low", noThink).reasoningEffort).toBe("low");
  });

  it("still appends the harmony Reasoning line for gpt-oss (which supports reasoning)", () => {
    const out = applyEffort(reqFor("gpt-oss:120b"), "high");
    expect(out.reasoningEffort).toBe("high");
    expect(
      out.messages.some((m) => m.role === "system" && m.content.includes("Reasoning: high")),
    ).toBe(true);
  });

  it("clamps xhigh to a standard high on the wire for a model that does not honor it", () => {
    const out = applyEffort(reqFor("qwen3.6:35b"), "xhigh");
    expect(out.reasoningEffort).toBe("high");
    expect(out.messages.some((m) => m.content.includes("Reasoning strength"))).toBe(false);
  });
});

describe("EFFORTS", () => {
  it("ships low, medium, high, xhigh in order, each with a non-empty description", () => {
    expect(EFFORTS.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh"]);
    for (const e of EFFORTS) expect(e.description.trim().length).toBeGreaterThan(0);
  });
  it("defaults to medium", () => {
    expect(DEFAULT_EFFORT).toBe("medium");
  });
});

describe("resolveEffortName", () => {
  it("matches an exact id", () => {
    expect(resolveEffortName("low")).toBe("low");
  });
  it("matches an unambiguous prefix", () => {
    expect(resolveEffortName("h")).toBe("high");
    expect(resolveEffortName("med")).toBe("medium");
    expect(resolveEffortName("l")).toBe("low");
  });
  it("resolves xhigh and its unambiguous prefixes", () => {
    expect(resolveEffortName("xhigh")).toBe("xhigh");
    expect(resolveEffortName("x")).toBe("xhigh");
    expect(resolveEffortName("xh")).toBe("xhigh");
  });
  it("is case-insensitive and trims", () => {
    expect(resolveEffortName("  HIGH ")).toBe("high");
  });
  it("returns null for unknown", () => {
    expect(resolveEffortName("turbo")).toBeNull();
  });
  it("returns null for empty", () => {
    expect(resolveEffortName("")).toBeNull();
  });
});

describe("resolveStartEffort", () => {
  it("uses the config default when no flag is given", () => {
    expect(resolveStartEffort("medium", undefined)).toEqual({ effort: "medium", warnings: [] });
  });
  it("lets a valid flag override the config default", () => {
    expect(resolveStartEffort("medium", "high")).toEqual({ effort: "high", warnings: [] });
  });
  it("warns and falls back to the config default on an unknown flag", () => {
    const r = resolveStartEffort("medium", "bogus");
    expect(r.effort).toBe("medium");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/unknown --effort/);
  });
});

describe("completeEffortLine", () => {
  it("completes a /effort partial (substring match surfaces high and xhigh for 'hi')", () => {
    expect(completeEffortLine("/effort hi")).toEqual([
      {
        display: "high — most thorough; more thinking, slower and more tokens",
        value: "/effort high",
      },
      {
        display:
          "xhigh — extended reasoning; only some models honor it (e.g. Muse), else same as high",
        value: "/effort xhigh",
      },
    ]);
  });
  it("completes the xhigh tier from its distinctive prefix", () => {
    expect(completeEffortLine("/effort xh")).toEqual([
      {
        display:
          "xhigh — extended reasoning; only some models honor it (e.g. Muse), else same as high",
        value: "/effort xhigh",
      },
    ]);
  });
  it("returns nothing for a non-/effort line", () => {
    expect(completeEffortLine("/persona cod")).toEqual([]);
  });
});
