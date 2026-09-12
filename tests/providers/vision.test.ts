import { expect, test } from "bun:test";
import { DEFAULT_VISION } from "../../src/config/vision";
import { gateVision, parseOllamaVision } from "../../src/providers/vision";

test("parseOllamaVision reads the capabilities array", () => {
  expect(parseOllamaVision({ capabilities: ["completion", "vision"] })).toBe("yes");
  expect(parseOllamaVision({ capabilities: ["completion"] })).toBe("no");
  expect(parseOllamaVision({})).toBe("unknown");
  expect(parseOllamaVision(null)).toBe("unknown");
});

test("gateVision blocks known-text-only, warns on unknown, sends on yes", () => {
  expect(gateVision("no", "qwen3", DEFAULT_VISION).action).toBe("block");
  expect(gateVision("unknown", "mystery", DEFAULT_VISION).action).toBe("warn");
  expect(gateVision("yes", "llava", DEFAULT_VISION).action).toBe("send");
});

test("gateVision honors assumeSupported and the models allowlist", () => {
  expect(gateVision("no", "custom", { ...DEFAULT_VISION, assumeSupported: true }).action).toBe(
    "send",
  );
  expect(gateVision("no", "my-llava-x", { ...DEFAULT_VISION, models: ["llava"] }).action).toBe(
    "send",
  );
});

test("gateVision ignores empty-string entries in the models allowlist (no accidental force-send)", () => {
  expect(gateVision("no", "qwen3", { ...DEFAULT_VISION, models: [""] }).action).toBe("block");
});
