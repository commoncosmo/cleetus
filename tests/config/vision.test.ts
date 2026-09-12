import { expect, test } from "bun:test";
import { DEFAULT_VISION, resolveVision } from "../../src/config/vision";

test("resolveVision falls back to defaults", () => {
  expect(resolveVision()).toEqual(DEFAULT_VISION);
});

test("project overrides global overrides default", () => {
  const cfg = resolveVision(
    { assume_supported: true, max_per_turn: 4 },
    { max_per_turn: 2, models: ["llava"] },
  );
  expect(cfg.assumeSupported).toBe(true); // from global (project didn't set it)
  expect(cfg.maxPerTurn).toBe(2); // project wins
  expect(cfg.models).toEqual(["llava"]);
  expect(cfg.maxBytesSoft).toBe(DEFAULT_VISION.maxBytesSoft);
});
