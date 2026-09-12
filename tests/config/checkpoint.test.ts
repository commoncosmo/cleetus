import { describe, expect, it } from "bun:test";
import { DEFAULT_CHECKPOINT_MAX_CHECKPOINTS, resolveCheckpoint } from "../../src/config/checkpoint";

describe("resolveCheckpoint", () => {
  it("defaults: enabled, default checkpoint count", () => {
    expect(resolveCheckpoint(undefined, undefined)).toEqual({
      enabled: true,
      maxCheckpoints: DEFAULT_CHECKPOINT_MAX_CHECKPOINTS,
    });
  });

  it("project overrides global", () => {
    const r = resolveCheckpoint(
      { enabled: true, max_checkpoints: 5 },
      { enabled: false, max_checkpoints: 50 },
    );
    expect(r).toEqual({ enabled: false, maxCheckpoints: 50 });
  });

  it("falls back to global when project omits a field", () => {
    const r = resolveCheckpoint({ max_checkpoints: 8 }, {});
    expect(r).toEqual({ enabled: true, maxCheckpoints: 8 });
  });
});
