import { describe, expect, it } from "bun:test";
import {
  classifyEmptyTurn,
  cleanFinishPassError,
  finishPassErrorNotice,
  selectTurnEndNotice,
  truncationNotice,
} from "../../src/agent/empty-turn";

describe("classifyEmptyTurn", () => {
  it("flags tool-call markup in the reasoning channel (all flavors)", () => {
    const markups = [
      "<tool_call>{...}</tool_call>",
      "...trailing junk </tool_call>", // closing-only — the cleetus0111 repro
      "<function=bash>",
      "</function>",
      "<parameter=command>",
      "</parameter>",
      "<|channel|>commentary to=functions.bash",
      "to=functions.bash",
      "<|call|>",
    ];
    for (const r of markups) {
      const out = classifyEmptyTurn({ reasoning: r });
      expect(out.kind).toBe("empty_reasoning_markup");
    }
  });

  it("does not name a specific model/provider in the markup notice", () => {
    const out = classifyEmptyTurn({ reasoning: "<tool_call>x</tool_call>" });
    expect(out.text).not.toContain("gpt-oss");
    expect(out.text).not.toContain("LM Studio");
  });

  it("classifies non-empty prose with no markup as reasoning-only", () => {
    const out = classifyEmptyTurn({ reasoning: "Let me think about this approach first." });
    expect(out.kind).toBe("empty_reasoning_only");
  });

  it("does not treat the bare words 'function' or 'tool' as markup", () => {
    expect(classifyEmptyTurn({ reasoning: "I'll call the bash function as a tool." }).kind).toBe(
      "empty_reasoning_only",
    );
  });

  it("classifies empty / whitespace reasoning as nothing", () => {
    expect(classifyEmptyTurn({ reasoning: "" }).kind).toBe("empty_nothing");
    expect(classifyEmptyTurn({ reasoning: "   \n\t" }).kind).toBe("empty_nothing");
  });

  it("returns a non-empty warn-worthy text for every kind", () => {
    for (const r of ["<tool_call>x</tool_call>", "just thinking", ""]) {
      expect(classifyEmptyTurn({ reasoning: r }).text.length).toBeGreaterThan(0);
    }
  });

  it("is case-insensitive about markup tags", () => {
    expect(classifyEmptyTurn({ reasoning: "<TOOL_CALL>X</TOOL_CALL>" }).kind).toBe(
      "empty_reasoning_markup",
    );
  });
});

describe("truncationNotice", () => {
  it("is the truncated_length kind with actionable text", () => {
    const out = truncationNotice();
    expect(out.kind).toBe("truncated_length");
    expect(out.text.toLowerCase()).toContain("cut off");
    expect(out.text.toLowerCase()).toContain("continue");
    expect(out.text).not.toContain("gpt-oss");
    expect(out.text).not.toContain("qwen");
  });
});

describe("cleanFinishPassError", () => {
  it("reduces a timeout message to 'timed out'", () => {
    expect(
      cleanFinishPassError("PROVIDER_UNREACHABLE: chat failed: The operation timed out."),
    ).toBe("timed out");
  });

  it("reduces a connection failure to 'unreachable'", () => {
    expect(
      cleanFinishPassError("PROVIDER_UNREACHABLE: chat failed: fetch failed (ECONNREFUSED)"),
    ).toBe("unreachable");
  });

  it("strips the provider wrapper prefixes from an unrecognized message", () => {
    expect(cleanFinishPassError("PROVIDER_UNREACHABLE: chat failed: model 'x' not found")).toBe(
      "model 'x' not found",
    );
  });
});

describe("finishPassErrorNotice", () => {
  it("names the model and cleaned reason, without the raw provider prefix", () => {
    const out = finishPassErrorNotice(
      "qwen3.5:122b-a10b",
      "PROVIDER_UNREACHABLE: chat failed: The operation timed out.",
    );
    expect(out.kind).toBe("finish_pass_error");
    expect(out.text).toContain("qwen3.5:122b-a10b");
    expect(out.text).toContain("timed out");
    expect(out.text).not.toContain("PROVIDER_UNREACHABLE");
  });
});

describe("selectTurnEndNotice", () => {
  const base = { finishReason: "stop" as const, finalText: "", reasoning: "", aborted: false };

  it("length truncation wins, even with non-empty partial text", () => {
    const empty = selectTurnEndNotice({ ...base, finishReason: "length" });
    expect(empty).not.toBeNull();
    expect(empty?.kind).toBe("truncated_length");
    const partial = selectTurnEndNotice({
      ...base,
      finishReason: "length",
      finalText: "half an answer",
    });
    expect(partial?.kind).toBe("truncated_length");
  });

  it("empty stop falls through to the reasoning-based classification", () => {
    expect(selectTurnEndNotice({ ...base, reasoning: "just thinking" })).toMatchObject({
      kind: "empty_reasoning_only",
    });
    expect(selectTurnEndNotice({ ...base, reasoning: "<tool_call>x</tool_call>" })).toMatchObject({
      kind: "empty_reasoning_markup",
    });
    expect(selectTurnEndNotice({ ...base, reasoning: "" })).toMatchObject({
      kind: "empty_nothing",
    });
  });

  it("returns null for a normal answered turn, an abort, and a server error", () => {
    expect(selectTurnEndNotice({ ...base, finalText: "here is the answer" })).toBeNull();
    expect(selectTurnEndNotice({ ...base, finishReason: "length", aborted: true })).toBeNull();
    expect(selectTurnEndNotice({ ...base, finishReason: "error" })).toBeNull();
  });
});
