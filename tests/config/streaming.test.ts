import { describe, expect, it } from "bun:test";
import { resolveStreaming } from "../../src/config/streaming";

describe("resolveStreaming", () => {
  it("defaults all fields when nothing is set", () => {
    expect(resolveStreaming(undefined, undefined)).toEqual({
      enabled: true,
      reasoning: true,
      reasoningLines: 10,
      proseLines: 12,
    });
  });

  it("lets project override global for enabled", () => {
    expect(resolveStreaming({ enabled: true }, { enabled: false })).toEqual({
      enabled: false,
      reasoning: true,
      reasoningLines: 10,
      proseLines: 12,
    });
  });

  it("lets project override global for reasoning", () => {
    expect(resolveStreaming({ reasoning: true }, { reasoning: false })).toEqual({
      enabled: true,
      reasoning: false,
      reasoningLines: 10,
      proseLines: 12,
    });
  });

  it("falls back to global when project omits a field", () => {
    expect(resolveStreaming({ enabled: false, reasoning: false }, {})).toEqual({
      enabled: false,
      reasoning: false,
      reasoningLines: 10,
      proseLines: 12,
    });
  });

  it("resolves reasoning_lines with project-over-global precedence", () => {
    expect(resolveStreaming({ reasoning_lines: 8 }, undefined).reasoningLines).toBe(8);
    expect(resolveStreaming({ reasoning_lines: 8 }, { reasoning_lines: 20 }).reasoningLines).toBe(
      20,
    );
  });

  it("resolves prose_lines with project-over-global precedence", () => {
    expect(resolveStreaming({ prose_lines: 6 }, undefined).proseLines).toBe(6);
    expect(resolveStreaming({ prose_lines: 6 }, { prose_lines: 30 }).proseLines).toBe(30);
  });
});
